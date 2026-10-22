import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectHooksHardeningFindings } from "./audit-extra.sync.js";
import { runSecurityAuditCore } from "./audit.js";

function hasFinding(
  findings: ReturnType<typeof collectHooksHardeningFindings>,
  checkId: string,
  severity: "warn" | "critical",
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function getFinding(findings: ReturnType<typeof collectHooksHardeningFindings>, checkId: string) {
  return findings.find((finding) => finding.checkId === checkId);
}

type AuditOptions = Parameters<typeof runSecurityAuditCore>[0];
const hookToken = "shared-gateway-token-1234567890";
const baseHooks = { enabled: true, token: hookToken, defaultSessionKey: "hook:ingress" };
const passwordRef = { source: "env", provider: "default", id: "GW_PASSWORD" } as const;
const gatewayPassword = "config-gateway-password-1234567890";
const reuseId = "hooks.token_reuse_gateway_token";
function auditSecretReuse(
  auth: NonNullable<OpenClawConfig["gateway"]>["auth"],
  token: string,
  options: Partial<AuditOptions> = {},
  providers: NonNullable<OpenClawConfig["secrets"]>["providers"] = { default: { source: "env" } },
) {
  return runSecurityAuditCore({
    config: {
      agents: { entries: { main: {} } },
      secrets: { providers },
      gateway: { auth },
      hooks: { enabled: true, token },
    },
    env: {},
    includeFilesystem: false,
    includeChannelSecurity: false,
    ...options,
  });
}

describe("security audit hooks ingress findings", () => {
  it("evaluates hooks ingress auth and routing findings", () => {
    const requestSessionKeyHooks = { ...baseHooks, allowRequestSessionKey: true };
    function check(
      cfg: OpenClawConfig,
      suffix: string,
      severity: "warn" | "critical" = "warn",
      env = process.env,
    ) {
      const findings = collectHooksHardeningFindings(cfg, env);
      expect(hasFinding(findings, `hooks.${suffix}`, severity), suffix).toBe(true);
      return findings;
    }
    check({ hooks: { enabled: true, token: "short" } }, "token_too_short");
    check({ hooks: { enabled: true, token: hookToken } }, "token_reuse_gateway_token", "critical", {
      OPENCLAW_GATEWAY_TOKEN: hookToken,
    });
    check({ hooks: { enabled: true, token: hookToken } }, "default_session_key_unset");
    check({ hooks: { ...baseHooks, allowedAgentIds: ["*"] } }, "allowed_agent_ids_unrestricted");
    check({ hooks: baseHooks }, "allowed_agent_ids_unrestricted");
    check(
      { gateway: { bind: "lan" }, hooks: baseHooks },
      "allowed_agent_ids_unrestricted",
      "critical",
    );
    const local = check({ hooks: requestSessionKeyHooks }, "request_session_key_enabled");
    expect(hasFinding(local, "hooks.request_session_key_prefixes_missing", "warn")).toBe(true);
    check(
      { gateway: { bind: "lan" }, hooks: requestSessionKeyHooks },
      "request_session_key_enabled",
      "critical",
    );
  });

  it("flags explicit audit password reuse when config mode is token", () => {
    const findings = collectHooksHardeningFindings(
      {
        gateway: {
          auth: {
            mode: "token",
            token: "config-gateway-token-1234567890", // pragma: allowlist secret
          },
        },
        hooks: {
          enabled: true,
          token: "runtime-only-gateway-password-1234567890",
        },
      },
      {},
      {
        gatewayAuthOverride: {
          mode: "password",
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(findings, reuseId);
    expect(finding).toMatchObject({
      severity: "critical",
      title: expect.stringContaining("Gateway password"),
      detail: expect.stringContaining("gateway.auth password"),
    });
  });

  it("keeps persisted SecretRef reuse findings when audit password override differs", async () => {
    const report = await auditSecretReuse(
      { mode: "password", password: passwordRef },
      gatewayPassword,
      {
        env: { GW_PASSWORD: gatewayPassword },
        auditGatewayAuthOverride: {
          mode: "password",
          password: "different-runtime-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(report.findings, reuseId);
    expect(finding).toMatchObject({
      severity: "critical",
      remediation: expect.stringContaining("openclaw doctor --fix"),
    });
  });

  it("flags hooks token reuse of SecretRef-backed trusted-proxy password fallback", async () => {
    const report = await auditSecretReuse(
      {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user" },
        password: passwordRef,
      },
      "trusted-proxy-local-password-1234567890",
      { env: { GW_PASSWORD: "trusted-proxy-local-password-1234567890" } }, // pragma: allowlist secret
    );

    expect(hasFinding(report.findings, reuseId, "critical")).toBe(true);
  });

  it("skips unavailable gateway auth SecretRefs when auditing hooks token reuse", async () => {
    const report = await auditSecretReuse(
      {
        mode: "password",
        password: { ...passwordRef, id: "MISSING_GW_PASSWORD" },
      },
      "shared-gateway-password-1234567890",
    );

    expect(hasFinding(report.findings, reuseId, "critical")).toBe(false);
  });

  it("does not execute gateway auth SecretRefs during hooks token reuse audit", async () => {
    const report = await auditSecretReuse(
      { mode: "password", password: { source: "exec", provider: "vault", id: "GW_PASSWORD" } },
      "shared-gateway-password-1234567890",
      {},
      {
        vault: {
          source: "exec",
          command: "node",
          args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"],
        },
      },
    );

    expect(hasFinding(report.findings, reuseId, "critical")).toBe(false);
  });
});
