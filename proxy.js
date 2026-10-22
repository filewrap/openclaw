"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const crypto = require("node:crypto");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 7860);
const GATEWAY_PORT = Number(
  process.env.OPENCLAW_GATEWAY_PORT || 18789
);
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  `${process.env.OPENCLAW_STATE_DIR || "/data/openclaw"}/openclaw.json`;

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

// Derive an HMAC cookie value so the raw token is never stored in the cookie
const AUTH_COOKIE_NAME = "oc_auth";
const EXPECTED_COOKIE_VALUE = TOKEN
  ? crypto.createHmac("sha256", TOKEN).update("openclaw-proxy-auth").digest("hex")
  : "";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthenticated(req) {
  if (!TOKEN) return false;
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`)
  );
  if (!match) return false;
  return safeEqual(match[1], EXPECTED_COOKIE_VALUE);
}

function confirmToken() {
  if (!TOKEN) {
    console.error(
      "[proxy] TOKEN CHECK FAILED: OPENCLAW_GATEWAY_TOKEN is missing."
    );
    return;
  }

  console.log("[proxy] TOKEN CHECK: environment token is configured.");
  console.log(`[proxy] Token length: ${TOKEN.length}`);
  console.log(`[proxy] Token fingerprint: ${fingerprint(TOKEN)}`);

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const configToken = config?.gateway?.auth?.token;

    if (typeof configToken !== "string" || !configToken) {
      console.error(
        "[proxy] TOKEN CHECK FAILED: gateway.auth.token is missing from config."
      );
    } else if (configToken === TOKEN) {
      console.log(
        "[proxy] TOKEN CHECK PASSED: environment token matches gateway config."
      );
    } else {
      console.error(
        "[proxy] TOKEN CHECK FAILED: environment token DOES NOT match gateway config."
      );
      console.error(
        `[proxy] Config token fingerprint: ${fingerprint(configToken)}`
      );
    }
  } catch (err) {
    console.error(
      `[proxy] Could not verify gateway config at ${CONFIG_PATH}: ${err.message}`
    );
  }
}

function buildUpstreamHeaders(reqHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (
      lower === "forwarded" ||
      lower === "x-real-ip" ||
      lower === "true-client-ip" ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("cf-")
    ) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

function renderLoginPage(errorMsg = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Authentication</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center;
      justify-content: center; background: #0d1117; color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      padding: 28px; width: 100%; max-width: 360px; box-sizing: border-box;
    }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 16px; font-size: 13px; color: #8b949e; }
    input {
      width: 100%; padding: 10px 12px; border-radius: 6px;
      border: 1px solid #30363d; background: #0d1117; color: #e6edf3;
      box-sizing: border-box; margin-bottom: 12px; font-size: 14px;
    }
    button {
      width: 100%; padding: 10px; border-radius: 6px; border: none;
      background: #238636; color: #fff; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #2ea043; }
    .err { color: #f85149; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/__proxy_login">
    <h2>OpenClaw Gateway</h2>
    <p>Enter your OPENCLAW_GATEWAY_TOKEN to unlock this Space.</p>
    ${errorMsg ? `<div class="err">${errorMsg}</div>` : ""}
    <input type="password" name="token" placeholder="Gateway Token" required autofocus>
    <button type="submit">Unlock</button>
  </form>
</body>
</html>`;
}

confirmToken();

const server = http.createServer((req, res) => {
  if (req.url === "/__proxy_health") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({ status: "ok", service: "proxy" }));
    return;
  }

  // Handle login submission
  if (req.method === "POST" && req.url === "/__proxy_login") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submitted = (params.get("token") || "").trim();

      if (safeEqual(submitted, TOKEN)) {
        res.writeHead(302, {
          location: "/#token=" + encodeURIComponent(TOKEN),
          "set-cookie": `${AUTH_COOKIE_NAME}=${EXPECTED_COOKIE_VALUE}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=None`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer"
        });
        res.end();
      } else {
        res.writeHead(401, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(renderLoginPage("Invalid Gateway Token."));
      }
    });
    return;
  }

  // Block all unauthenticated requests before they reach OpenClaw
  if (!isAuthenticated(req)) {
    res.writeHead(401, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(renderLoginPage());
    return;
  }

  const headers = buildUpstreamHeaders(req.headers);

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: GATEWAY_PORT,
      method: req.method,
      path: req.url,
      headers
    },
    (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode || 502,
        upstreamRes.headers
      );
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    console.error("[proxy] Gateway request failed:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, {
        "content-type": "text/plain",
        "cache-control": "no-store"
      });
    }
    res.end("OpenClaw Gateway unavailable");
  });

  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });

  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  // Reject WebSocket connections from unauthenticated clients immediately
  if (!isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstream = net.connect({
    host: "127.0.0.1",
    port: GATEWAY_PORT
  });

  upstream.once("connect", () => {
    const headers = buildUpstreamHeaders(req.headers);

    let request =
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;

    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          request += `${name}: ${item}\r\n`;
        }
      } else {
        request += `${name}: ${value}\r\n`;
      }
    }

    request += "\r\n";
    upstream.write(request);

    if (head.length) upstream.write(head);

    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", (err) => {
    console.error("[proxy] WebSocket failed:", err.message);
    socket.destroy();
  });

  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(
    `[proxy] Listening on ${HOST}:${PORT} -> 127.0.0.1:${GATEWAY_PORT}`
  );
});
