#!/usr/bin/env bash
set -Eeuo pipefail

HEALTH_PORT="${OPENCLAW_HEALTH_PORT:-7680}"
PROXY_PORT="${PORT:-7860}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"

: "${OPENCLAW_GATEWAY_TOKEN:?Set OPENCLAW_GATEWAY_TOKEN as a Space Secret}"

# Never use a wildcard origin as a security shortcut.
if [[ -z "${OPENCLAW_ALLOWED_ORIGINS:-}" ]]; then
    if [[ -n "${SPACE_HOST:-}" ]]; then
        export OPENCLAW_ALLOWED_ORIGINS="https://${SPACE_HOST}"
    else
        echo "[start.sh] Set OPENCLAW_ALLOWED_ORIGINS to your Space URL."
        exit 1
    fi
fi

export HEALTH_PORT PROXY_PORT GATEWAY_PORT
export OPENCLAW_HEALTH_PORT="$HEALTH_PORT"
export PORT="$PROXY_PORT"
export OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT"
export OPENCLAW_GATEWAY_TOKEN

# Prepare persistent state. The mounted /data must be writable by root.
mkdir -p "$STATE_DIR" "${STATE_DIR}/workspace"
chown -R node:node "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Build a configuration while preserving existing user settings.
gosu node node - <<'NODE'
const fs = require("fs");
const path = require("path");

const file = process.env.OPENCLAW_CONFIG_PATH;
const state = process.env.OPENCLAW_STATE_DIR;
const port = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
const origins = process.env.OPENCLAW_ALLOWED_ORIGINS
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!origins.length) {
  throw new Error("At least one allowed browser origin is required");
}

fs.mkdirSync(path.dirname(file), { recursive: true });

let config = {};
if (fs.existsSync(file)) {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
}

config.gateway ??= {};
config.gateway.mode = "local";
config.gateway.bind = "loopback";
config.gateway.port = port;
delete config.gateway.trustedProxies;

config.gateway.auth = {
  mode: "token",
  token: process.env.OPENCLAW_GATEWAY_TOKEN
};

config.gateway.controlUi ??= {};
config.gateway.controlUi.allowedOrigins = origins;
// Clean up retired keys if they were persisted in /data/openclaw/openclaw.json
delete config.gateway.controlUi.allowInsecureAuth;
delete config.gateway.controlUi.dangerouslyDisableDeviceAuth;

config.agents ??= {};
config.agents.defaults ??= {};
config.agents.defaults.workspace ??= `${state}/workspace`;

fs.writeFileSync(file, JSON.stringify(config, null, 2), {
  mode: 0o600
});
fs.chmodSync(file, 0o600);
NODE

SERVER_PID=""
PROXY_PID=""
GATEWAY_PID=""

cleanup() {
    trap - EXIT INT TERM

    for pid in "$GATEWAY_PID" "$PROXY_PID" "$SERVER_PID"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
        fi
    done

    for pid in "$GATEWAY_PID" "$PROXY_PID" "$SERVER_PID"; do
        if [[ -n "$pid" ]]; then
            wait "$pid" 2>/dev/null || true
        fi
    done
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_http() {
    local port="$1"
    local path="$2"
    local attempts="$3"

    for ((i=1; i<=attempts; i++)); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "[start.sh] Health server exited unexpectedly."
            return 1
        fi

        if [[ -n "$GATEWAY_PID" ]] &&
           ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
            echo "[start.sh] OpenClaw Gateway exited unexpectedly."
            return 1
        fi

        if curl -fsS --max-time 2 \
            "http://127.0.0.1:${port}${path}" >/dev/null 2>&1; then
            return 0
        fi

        sleep 1
    done

    echo "[start.sh] Timeout waiting for port ${port}${path}"
    return 1
}

# 1. Start the health server first.
gosu node python3 /app/server.py &
SERVER_PID=$!
echo "[start.sh] Health server PID: $SERVER_PID"

wait_http "$HEALTH_PORT" "/healthz" 30

# 2. Start the Gateway and wait until it is ready before opening port 7860.
gosu node openclaw gateway \
    --port "$GATEWAY_PORT" \
    --bind loopback \
    --auth token \
    --allow-unconfigured &
GATEWAY_PID=$!

echo "[start.sh] OpenClaw Gateway PID: $GATEWAY_PID"

wait_http "$GATEWAY_PORT" "/healthz" 120
echo "[start.sh] Gateway is responding."

# 3. Start the reverse proxy on the public Space port.
gosu node node /app/proxy.js &
PROXY_PID=$!
echo "[start.sh] Reverse proxy PID: $PROXY_PID"

for ((i=1; i<=30; i++)); do
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
        echo "[start.sh] Reverse proxy exited unexpectedly."
        exit 1
    fi

    if curl -sS --max-time 2 \
        "http://127.0.0.1:${PROXY_PORT}/__proxy_health" \
        >/dev/null 2>&1; then
        break
    fi

    sleep 1
done

if ! curl -fsS --max-time 2 \
    "http://127.0.0.1:${PROXY_PORT}/__proxy_health" \
    >/dev/null 2>&1; then
    echo "[start.sh] Reverse proxy failed to bind."
    exit 1
fi

echo "[start.sh] Public UI: port ${PROXY_PORT}"

# Keep PID 1 supervising all three processes.
set +e
wait -n "$SERVER_PID" "$PROXY_PID" "$GATEWAY_PID"
STATUS=$?
set -e

echo "[start.sh] A service exited (status ${STATUS}); shutting down."
exit "$STATUS"
