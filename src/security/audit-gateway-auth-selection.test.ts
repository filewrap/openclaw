import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

const remote = (auth: { token?: string; password?: string }) => ({
  url: "wss://remote.example.com:18789",
  ...auth,
});

describe("security audit gateway auth selection", () => {
  it("applies gateway auth precedence across local and remote modes", () => {
    const local = { token: "local-token" };
    const remoteToken = { token: "remote-token" };
    const remotePassword = { password: "remote-pass" };
    const cases: Array<
      [string, OpenClawConfig["gateway"], typeof local | typeof remotePassword, NodeJS.ProcessEnv?]
    > = [
      ["local", { mode: "local", auth: local }, local],
      [
        "config over env",
        { mode: "local", auth: local },
        local,
        { OPENCLAW_GATEWAY_TOKEN: "env-token" },
      ],
      ["default mode", { auth: local }, local],
      ["remote", { mode: "remote", auth: local, remote: remote(remoteToken) }, remoteToken],
      [
        "remote ignores env token",
        { mode: "remote", auth: local, remote: remote(remoteToken) },
        remoteToken,
        { OPENCLAW_GATEWAY_TOKEN: "env-token" },
      ],
      ["missing remote URL", { mode: "remote", auth: local, remote: remoteToken }, local],
      ["remote password", { mode: "remote", remote: remote(remotePassword) }, remotePassword],
      [
        "env password",
        { mode: "remote", remote: remote(remotePassword) },
        { password: "env-pass" },
        { OPENCLAW_GATEWAY_PASSWORD: "env-pass" },
      ],
    ];

    for (const [name, gateway, expectedAuth, env = {}] of cases) {
      const cfg = { gateway };
      const result = resolveGatewayProbeAuthSafe({
        cfg,
        env,
        mode: resolveGatewayProbeTarget(cfg).mode,
      });
      expect(result.auth, name).toEqual(expectedAuth);
    }
  });

  it("adds warning finding when probe auth SecretRef is unavailable", () => {
    const token = { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" } as const;
    const cfg: OpenClawConfig = {
      gateway: { mode: "local", auth: { mode: "token", token } },
      secrets: { providers: { default: { source: "env" } } },
    };

    const result = resolveGatewayProbeAuthSafe({ cfg, mode: "local", env: {} });
    const findings = collectDeepProbeFindings({
      deep: {
        gateway: {
          attempted: true,
          url: "ws://127.0.0.1:18789",
          ok: true,
          error: null,
          close: null,
        },
      },
      authWarning: result.warning,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        detail: expect.stringContaining("gateway.auth.token"),
      }),
    );
  });
});
