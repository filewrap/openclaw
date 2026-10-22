import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig as Config } from "../config/config.js";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { resolveGatewayProbeAuthSafe } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
  collectHooksHardeningFindings,
} from "./audit-extra.sync.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";
import { runSecurityAuditCore } from "./audit.js";

type Findings = ReturnType<typeof collectGatewayConfigFindings>;
type Severity = Findings[number]["severity"];
type Gateway = NonNullable<Config["gateway"]>;
type Binding = NonNullable<Config["bindings"]>[number];
const critical = "critical",
  warn = "warn";
const auth = { mode: "token", token: "very-long-browser-token-0123456789" } as const;
const proxy = { userHeader: "x-forwarded-user" };
const allowed = { ...proxy, allowUsers: ["nick@example.com"] };
const disabled = { elevated: { enabled: false } };
const multiUser = "security.trust_model.multi_user_heuristic";
const groupScope = "security.trust_model.group_scope_main";
const elevated = "security.exposure.open_groups_with_elevated";
const runtime = "security.exposure.open_groups_with_runtime_or_fs";
const control = "security.exposure.open_groups_with_control_plane_tools";
const flag = "config.insecure_or_dangerous_flags";
const reuse = "hooks.token_reuse_gateway_token";
const small = "ollama/mistral-8b";
const web = { search: { enabled: true }, fetch: { enabled: true } };
const browser = { enabled: true };
const denyWeb = { deny: ["web_search", "web_fetch", "browser"] };

function has(findings: Findings, id: string, severity?: Severity, detail: string[] = []) {
  const found = expectDefined(
    findings.find((entry) => entry.checkId === id),
    id,
  );
  if (severity) {
    expect(found.severity).toBe(severity);
  }
  for (const text of detail) {
    expect(found.detail).toContain(text);
  }
  return found;
}
function lacks(findings: Findings, ...ids: string[]) {
  for (const checkId of ids) {
    expect(findings).not.toContainEqual(expect.objectContaining({ checkId }));
  }
}
const audit = (cfg: Config) => collectGatewayConfigFindings(cfg, cfg, {});
const gateway = (settings: Gateway): Config => ({ gateway: settings });
const trusted = (settings: GatewayTrustedProxyConfig, trustedProxies = ["10.0.0.1"]) =>
  gateway({ bind: "lan", trustedProxies, auth: { mode: "trusted-proxy", trustedProxy: settings } });
const channel = (channels: Config["channels"], tools?: Config["tools"]): Config => ({
  channels,
  ...(tools ? { tools } : {}),
});
const openGroup = (tools: Config["tools"] = {}, agents?: Config["agents"]): Config => ({
  ...channel({ whatsapp: { groupPolicy: "open" } }, { ...disabled, ...tools }),
  agents,
});
const openDm = (tools: Config["tools"]): Config =>
  channel({ slack: { dmPolicy: "open" } }, { ...disabled, ...tools });
const bindings = (...entries: Binding[]): Config => ({ bindings: entries });
const binding = (
  match: Binding["match"],
  scope: "main" | "per-group",
  agentId = "support",
): Binding => ({ agentId, match, session: { groupScope: scope } });
const room = (agent: string, scope: "main" | "per-group", kind?: "group" | "channel") =>
  binding(
    { channel: "discord", accountId: "work", ...(kind ? { peer: { kind, id: "room-1" } } : {}) },
    scope,
    agent,
  );
const trust = (cfg: Config) => [
  ...collectExposureMatrixFindings(cfg),
  ...collectLikelyMultiUserSetupFindings(cfg),
];

type Check = [string, Severity?, string[]?];
describe("gateway exposure", () => {
  it.each<{ name: string; cfg: Config; checks: Check[]; absent?: string[] }>`
    name                        | cfg                                                                                                                                                            | checks                                                                                                                                                    | absent
    ${"MCP Apps"}               | ${{ mcp: { apps: { enabled: true } } }}                                                                                                                        | ${[["mcp.apps.enabled", warn]]}                                                                                                                           | ${undefined}
    ${"loopback origins"}       | ${gateway({ bind: "loopback", controlUi: { allowedOrigins: ["*"] } })}                                                                                         | ${[["gateway.control_ui.allowed_origins_wildcard", warn]]}                                                                                                | ${undefined}
    ${"LAN origins"}            | ${gateway({ bind: "lan", auth, controlUi: { allowedOrigins: ["*"] } })}                                                                                        | ${[["gateway.control_ui.allowed_origins_wildcard", critical]]}                                                                                            | ${["gateway.control_ui.allowed_origins_required"]}
    ${"host fallback"}          | ${gateway({ bind: "lan", auth, controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } })}                                                               | ${[["gateway.control_ui.host_header_origin_fallback", critical], [flag, undefined, ["gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"]]]} | ${["gateway.control_ui.allowed_origins_required"]}
    ${"local real IP"}          | ${gateway({ bind: "loopback", allowRealIpFallback: true, trustedProxies: ["127.0.0.1"], auth: { mode: "trusted-proxy", trustedProxy: proxy } })}               | ${[["gateway.real_ip_fallback_enabled", warn]]}                                                                                                           | ${undefined}
    ${"remote proxy real IP"}   | ${gateway({ bind: "loopback", allowRealIpFallback: true, trustedProxies: ["127.0.0.1", "10.0.0.0/8"], auth: { mode: "trusted-proxy", trustedProxy: proxy } })} | ${[["gateway.real_ip_fallback_enabled", critical]]}                                                                                                       | ${undefined}
    ${"other loopback real IP"} | ${gateway({ bind: "loopback", allowRealIpFallback: true, trustedProxies: ["127.0.0.2"], auth: { mode: "trusted-proxy", trustedProxy: proxy } })}               | ${[["gateway.real_ip_fallback_enabled", critical]]}                                                                                                       | ${undefined}
    ${"malformed CIDR real IP"} | ${gateway({ bind: "loopback", allowRealIpFallback: true, trustedProxies: ["127.0.0.1/32abc"], auth: { mode: "trusted-proxy", trustedProxy: proxy } })}         | ${[["gateway.real_ip_fallback_enabled", critical]]}                                                                                                       | ${undefined}
    ${"local mDNS"}             | ${{ ...gateway({ bind: "loopback", auth: { mode: "token", token: "very-long-token-1234567890" } }), discovery: { mdns: { mode: "full" } } }}                   | ${[["discovery.mdns_full_mode", warn]]}                                                                                                                   | ${undefined}
    ${"LAN mDNS"}               | ${{ ...gateway({ bind: "lan", auth: { mode: "token", token: "very-long-token-1234567890" } }), discovery: { mdns: { mode: "full" } } }}                        | ${[["discovery.mdns_full_mode", critical]]}                                                                                                               | ${undefined}
  `("audits $name", ({ cfg, checks, absent = [] }) => {
    const findings = audit(cfg);
    for (const [id, severity, detail] of checks) {
      has(findings, id, severity, detail);
    }
    lacks(findings, ...absent);
  });
  it("warns for every enabled dangerous flag", () => {
    const cfg: Config = {
      hooks: {
        gmail: { allowUnsafeExternalContent: true },
        mappings: [{ allowUnsafeExternalContent: true }],
      },
      tools: { exec: { applyPatch: { workspaceOnly: false } } },
    };
    const details = [
      "hooks.gmail.allowUnsafeExternalContent=true",
      "hooks.mappings[0].allowUnsafeExternalContent=true",
      "tools.exec.applyPatch.workspaceOnly=false",
    ];
    const flags = audit(cfg).filter((entry) => entry.checkId === flag);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((entry) => entry.severity === warn)).toBe(true);
    for (const text of details) {
      expect(
        flags.some((entry) => entry.detail.includes(text)),
        text,
      ).toBe(true);
    }
  });
  it.each<{
    suffix: string;
    severity: Severity;
    settings: GatewayTrustedProxyConfig;
    proxies?: string[];
  }>`
    suffix                         | severity    | settings                                                                            | proxies
    ${"auth"}                      | ${critical} | ${proxy}                                                                            | ${undefined}
    ${"no_proxies"}                | ${critical} | ${proxy}                                                                            | ${[]}
    ${"no_user_header"}            | ${critical} | ${{} as never}                                                                      | ${undefined}
    ${"no_allowlist"}              | ${warn}     | ${{ ...proxy, allowUsers: [] }}                                                     | ${undefined}
    ${"allow_loopback"}            | ${warn}     | ${{ ...allowed, allowLoopback: true }}                                              | ${["127.0.0.1"]}
    ${"device_auto_approve"}       | ${warn}     | ${{ ...allowed, deviceAutoApprove: { enabled: true } }}                             | ${undefined}
    ${"device_auto_approve_admin"} | ${critical} | ${{ ...allowed, deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] } }} | ${undefined}
  `("checks trusted-proxy $suffix", ({ suffix, severity, settings, proxies }) => {
    const findings = audit(trusted(settings, proxies));
    has(findings, `gateway.trusted_proxy_${suffix}`, severity);
    has(findings, "gateway.trusted_proxy_auth");
    lacks(
      findings,
      "gateway.bind_no_auth",
      "gateway.loopback_no_auth",
      "gateway.auth_no_rate_limit",
    );
  });
});

describe("trust model", () => {
  it.each<{ cfg: Config; expected: boolean }>`
    cfg                                                                                                                                  | expected
    ${channel({ discord: { groupPolicy: "allowlist", accounts: { work: { guilds: { "1234567890": {} } } } } })}                          | ${true}
    ${channel({ discord: { groupPolicy: "allowlist", accounts: { work: { groupPolicy: "disabled", guilds: { "1234567890": {} } } } } })} | ${false}
  `("handles account group targets, enabled=$expected", ({ cfg, expected }) => {
    const findings = collectLikelyMultiUserSetupFindings(cfg);
    if (expected) {
      has(findings, multiUser, undefined, [
        'channels.discord.accounts.work.groupPolicy="allowlist" with configured group targets',
      ]);
    } else {
      lacks(findings, multiUser);
    }
  });
  const dm = { feishu: { groupPolicy: "disabled", dmPolicy: "open" } } as const;
  it.each<{ id: string; cfg: Config; severity: Severity | false | undefined; detail?: string[] }>`
    id            | cfg                                                                                                                                          | severity     | detail
    ${elevated}   | ${openGroup({ elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } })}                                                               | ${critical}  | ${undefined}
    ${runtime}    | ${openGroup()}                                                                                                                               | ${critical}  | ${undefined}
    ${runtime}    | ${openGroup({ profile: "coding" }, { defaults: { sandbox: { mode: "all" } } })}                                                              | ${false}     | ${undefined}
    ${runtime}    | ${openGroup({ profile: "coding", deny: ["group:runtime"], fs: { workspaceOnly: true } })}                                                    | ${false}     | ${undefined}
    ${multiUser}  | ${channel({ discord: { groupPolicy: "allowlist", guilds: { "1234567890": { channels: { "7777777777": { enabled: true } } } } } }, disabled)} | ${warn}      | ${['channels.discord.groupPolicy="allowlist" with configured group targets']}
    ${groupScope} | ${{ session: { groupScope: "main" } }}                                                                                                       | ${warn}      | ${['session.groupScope="main"', "all group/channel rooms"]}
    ${groupScope} | ${bindings(binding({ channel: "whatsapp", peer: { kind: "direct", id: "user-a" } }, "main"))}                                                | ${false}     | ${undefined}
    ${groupScope} | ${bindings(room("isolated", "per-group", "group"), room("shared", "main", "channel"))}                                                       | ${false}     | ${undefined}
    ${groupScope} | ${bindings(room("shared", "main", "channel"), room("isolated", "per-group", "group"))}                                                       | ${undefined} | ${["discord accountId=work peer=channel:room-1"]}
    ${groupScope} | ${bindings(room("isolated", "per-group"), room("shared", "main", "group"))}                                                                  | ${undefined} | ${["discord accountId=work peer=group:room-1"]}
    ${elevated}   | ${channel(dm, { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } })}                                                           | ${critical}  | ${["channels.feishu.dmPolicy"]}
    ${runtime}    | ${channel(dm, { ...disabled, profile: "coding" })}                                                                                           | ${critical}  | ${["channels.feishu.dmPolicy"]}
    ${elevated}   | ${{ channels: { discord: { dm: { policy: "open" } } } } as unknown as Config}                                                                | ${undefined} | ${["channels.discord.dm.policy"]}
    ${control}    | ${openGroup({ profile: "coding" })}                                                                                                          | ${critical}  | ${["channels.whatsapp.groupPolicy"]}
    ${control}    | ${openDm({ allow: ["gateway"] })}                                                                                                            | ${critical}  | ${["channels.slack.dmPolicy"]}
    ${control}    | ${openDm({ profile: "messaging", alsoAllow: ["cron"] })}                                                                                     | ${undefined} | ${undefined}
    ${control}    | ${openGroup({ profile: "messaging" }, { entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } } })}                    | ${undefined} | ${["agents.entries.ops", "agents.defaults"]}
    ${control}    | ${openGroup({ profile: "coding", deny: ["gateway", "cron", "plugins"] })}                                                                    | ${false}     | ${undefined}
    ${control}    | ${openGroup({ allow: ["nodes", "computer"] })}                                                                                               | ${false}     | ${undefined}
    ${control}    | ${channel({ whatsapp: { groupPolicy: "allowlist" } }, { ...disabled, profile: "coding" })}                                                   | ${false}     | ${undefined}
  `("audits $id", ({ id, cfg, severity, detail }) => {
    const findings = trust(cfg);
    if (severity === false) {
      lacks(findings, id);
    } else {
      has(findings, id, severity, detail);
    }
  });
  it("does not infer shared users without signals", () => {
    lacks(
      trust(channel({ discord: { groupPolicy: "allowlist" } }, disabled)),
      multiUser,
      groupScope,
    );
  });
  it("reports only the matched room's scope", () => {
    const cfg: Config = {
      session: { groupScope: "per-group" },
      ...bindings(
        binding(
          {
            channel: "discord",
            accountId: "work",
            peer: { kind: "channel", id: "1234567890" },
            guildId: "9876543210",
            roles: ["operators", "reviewers"],
          },
          "main",
        ),
      ),
    };
    const detail =
      "discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers";
    expect(has(trust(cfg), groupScope, warn, [detail]).detail).not.toContain(
      "all group/channel rooms",
    );
  });
  it("reports the effective canonical, account, or nested-only DM policy", () => {
    const account = channel({
      discord: { dmPolicy: "allowlist", accounts: { work: { dmPolicy: "open" } } },
    });
    expect(
      has(trust(account), elevated, undefined, ["channels.discord.accounts.work.dmPolicy"]).detail,
    ).not.toContain("channels.discord.dmPolicy");
    const nested = has(
      trust(channel({ matrix: { dm: { policy: "open" } } })),
      elevated,
      undefined,
      ["channels.matrix.dm.policy"],
    );
    expect(nested.remediation).toContain("each listed group/DM policy");
    expect(nested.remediation).not.toContain("dmPolicy");
    const canonical = trust({
      channels: { discord: { dmPolicy: "allowlist", dm: { policy: "open" } } },
    } as unknown as Config);
    expect(
      canonical.some((entry) => entry.checkId.startsWith("security.exposure.open_groups_")),
    ).toBe(false);
  });
});

const hookToken = "shared-gateway-token-1234567890";
const baseHooks = { enabled: true, token: hookToken, defaultSessionKey: "hook:ingress" };
const hookCfg = (hooks: Config["hooks"], remote = false): Config => ({
  hooks,
  ...(remote ? gateway({ bind: "lan" }) : {}),
});
const ref = { source: "env", provider: "default", id: "GW_PASSWORD" } as const;
const password = "shared-gateway-password-1234567890";
type AuditOptions = Parameters<typeof runSecurityAuditCore>[0];
type Providers = NonNullable<Config["secrets"]>["providers"];
describe("hook ingress", () => {
  it("reports short tokens, missing sessions, and env credential reuse", () => {
    const cfg = hookCfg({ enabled: true, token: hookToken });
    has(
      collectHooksHardeningFindings(hookCfg({ enabled: true, token: "short" })),
      "hooks.token_too_short",
      warn,
    );
    has(collectHooksHardeningFindings(cfg), "hooks.default_session_key_unset", warn);
    has(collectHooksHardeningFindings(cfg, { OPENCLAW_GATEWAY_TOKEN: hookToken }), reuse, critical);
  });
  it.each<{ allowedAgentIds: string[] | undefined; remote: boolean; severity: Severity }>`
    allowedAgentIds | remote   | severity
    ${undefined}    | ${false} | ${warn}
    ${["*"]}        | ${false} | ${warn}
    ${undefined}    | ${true}  | ${critical}
  `(
    "scores unrestricted agents $allowedAgentIds remote=$remote",
    ({ allowedAgentIds, remote, severity }) => {
      const hooks = allowedAgentIds ? { ...baseHooks, allowedAgentIds } : baseHooks;
      has(
        collectHooksHardeningFindings(hookCfg(hooks, remote)),
        "hooks.allowed_agent_ids_unrestricted",
        severity,
      );
    },
  );
  it.each<{ remote: boolean; severity: Severity }>`
    remote   | severity
    ${false} | ${warn}
    ${true}  | ${critical}
  `("scores session overrides, remote=$remote", ({ remote, severity }) => {
    const cfg = hookCfg({ ...baseHooks, allowRequestSessionKey: true }, remote);
    const findings = collectHooksHardeningFindings(cfg);
    has(findings, "hooks.request_session_key_enabled", severity);
    if (!remote) {
      has(findings, "hooks.request_session_key_prefixes_missing", warn);
    }
  });
  it("detects runtime password reuse despite persisted token mode", () => {
    const runtimePassword = "runtime-only-gateway-password-1234567890";
    const cfg: Config = {
      gateway: { auth: { mode: "token", token: "config-gateway-token-1234567890" } },
      hooks: { enabled: true, token: runtimePassword },
    };
    has(
      collectHooksHardeningFindings(
        cfg,
        {},
        { gatewayAuthOverride: { mode: "password", password: runtimePassword } },
      ),
      reuse,
      critical,
      ["gateway.auth password"],
    );
  });
  it.each<{
    gatewayAuth: Gateway["auth"];
    options: Partial<AuditOptions>;
    expected: boolean;
    providers?: Providers;
  }>`
    gatewayAuth                                                                                 | options                                                                                                                                  | expected | providers
    ${{ mode: "password", password: ref }}                                                      | ${{ env: { GW_PASSWORD: password }, auditGatewayAuthOverride: { mode: "password", password: "different-runtime-password-1234567890" } }} | ${true}  | ${undefined}
    ${{ mode: "trusted-proxy", trustedProxy: proxy, password: ref }}                            | ${{ env: { GW_PASSWORD: password } }}                                                                                                    | ${true}  | ${undefined}
    ${{ mode: "password", password: { ...ref, id: "MISSING_GW_PASSWORD" } }}                    | ${{}}                                                                                                                                    | ${false} | ${undefined}
    ${{ mode: "password", password: { source: "exec", provider: "vault", id: "GW_PASSWORD" } }} | ${{}}                                                                                                                                    | ${false} | ${{ vault: { source: "exec", command: "node", args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"] } }}
  `(
    "audits secret reuse $gatewayAuth",
    async ({ gatewayAuth, options, expected, providers = { default: { source: "env" } } }) => {
      const report = await runSecurityAuditCore({
        config: {
          agents: { entries: { main: {} } },
          secrets: { providers },
          gateway: { auth: gatewayAuth },
          hooks: { enabled: true, token: password },
        },
        env: {},
        includeFilesystem: false,
        includeChannelSecurity: false,
        ...options,
      });
      if (expected) {
        const found = has(report.findings, reuse, critical);
        if (options.auditGatewayAuthOverride) {
          expect(found.remediation).toContain("openclaw doctor --fix");
        }
      } else {
        expect(report.findings).not.toContainEqual(
          expect.objectContaining({ checkId: reuse, severity: critical }),
        );
      }
    },
  );
});

type Defaults = NonNullable<NonNullable<Config["agents"]>["defaults"]>;
const model = (primary = small, defaults: Defaults = {}): Config => ({
  agents: { defaults: { model: { primary }, ...defaults } },
  tools: { web },
  browser,
});
describe("small model policies", () => {
  it("retains canonical simple, primary, and fallback source paths", () => {
    const cfg: Config = {
      agents: {
        entries: {
          simple: { model: small },
          structured: { model: { primary: "ollama/gemma-4b", fallbacks: ["ollama/phi-3b"] } },
        },
      },
    };
    const refs = [
      { id: small, source: "agents.entries.simple.model" },
      { id: "ollama/gemma-4b", source: "agents.entries.structured.model.primary" },
      { id: "ollama/phi-3b", source: "agents.entries.structured.model.fallbacks" },
    ];
    expect(collectAuditModelRefs(cfg)).toEqual(refs);
  });
  const providerModel = "openrouter/google/gemma-3-4b-it:free";
  it.each<{
    name: string;
    cfg: Config;
    severity: Severity | undefined;
    detail: string[];
    env?: NodeJS.ProcessEnv;
  }>`
    name                            | cfg                                                                                                                                                          | severity     | detail                                                  | env
    ${"agent policy"}               | ${{ agents: { entries: { ops: { model: { primary: small }, tools: denyWeb } } }, tools: { web }, browser }}                                                  | ${"info"}    | ${["@ agents.entries.ops.model.primary", "web=[off]"]}  | ${undefined}
    ${"enabled tools"}              | ${model()}                                                                                                                                                   | ${critical}  | ${["mistral-8b", "web_search", "web_fetch", "browser"]} | ${process.env}
    ${"sandbox and disabled tools"} | ${{ ...model(small, { sandbox: { mode: "all" } }), tools: { web: { search: { enabled: false }, fetch: { enabled: false } } }, browser: { enabled: false } }} | ${"info"}    | ${["mistral-8b", "sandbox=all"]}                        | ${process.env}
    ${"alias"}                      | ${model("tiny", { models: { [small]: { alias: "tiny" } } })}                                                                                                 | ${undefined} | ${[small, "@ agents.defaults.model.primary"]}           | ${undefined}
    ${"provider policy"}            | ${{ ...model(providerModel), tools: { web, byProvider: { [providerModel]: denyWeb } } }}                                                                     | ${"info"}    | ${[providerModel, "web=[off]"]}                         | ${undefined}
  `("audits $name", ({ name, cfg, severity, detail, env = {} }) => {
    const found = has(
      collectSmallModelRiskFindings({ cfg, env }),
      "models.small_params",
      severity,
      detail,
    );
    if (name === "alias") {
      expect(found.detail).not.toContain("- tiny");
    }
  });
});

it("reports unavailable probe auth even when the Gateway probe succeeds", () => {
  const cfg: Config = {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: { ...ref, id: "MISSING_GATEWAY_TOKEN" } },
    },
    secrets: { providers: { default: { source: "env" } } },
  };
  const deep = {
    gateway: { attempted: true, url: "ws://127.0.0.1:18789", ok: true, error: null, close: null },
  };
  const authWarning = resolveGatewayProbeAuthSafe({ cfg, mode: "local", env: {} }).warning;
  has(
    collectDeepProbeFindings({ deep, authWarning }),
    "gateway.probe_auth_secretref_unavailable",
    warn,
    ["gateway.auth.token"],
  );
});
