import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";
import { runSecurityAuditCore } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

const getFinding = (findings: SecurityAuditFinding[], checkId: string) =>
  findings.find((entry) => entry.checkId === checkId);
const openAccount = () => ({ policy: "open", allowFrom: ["*"] });
const mainSession = { dmScope: "main" } as const;
const mayShare = {
  title: expect.stringContaining("may share"),
  detail: expect.stringContaining("can resolve to the same session bucket"),
};

function collisionFindings(findings: SecurityAuditFinding[]): SecurityAuditFinding[] {
  return findings.filter((finding) => finding.checkId.includes(".dm.session_collision."));
}

type Accounts = Record<string, { policy?: string; allowFrom: Array<string | number> }>;
function createDmPlugin(
  accounts: Accounts = { default: { policy: "allowlist", allowFrom: ["user-a", "user-b"] } },
  dmRouting?: NonNullable<ChannelPlugin["security"]>["dmRouting"],
  id: "telegram" | "whatsapp" = "whatsapp",
): ChannelPlugin & { security: NonNullable<ChannelPlugin["security"]> } {
  const accountIds = Object.keys(accounts);
  return {
    ...createChannelTestPluginBase({
      id,
      label: id === "telegram" ? "Telegram" : "WhatsApp",
      config: {
        listAccountIds: () => accountIds,
        defaultAccountId: () => accountIds[0] ?? "default",
        inspectAccount: () => ({ enabled: true, configured: true }),
      },
    }),
    security: {
      resolveDmPolicy: ({ accountId = "default" }) => {
        const key = accountId ?? "default";
        const account = accounts[key];
        return account
          ? {
              policy: account.policy ?? "allowlist",
              allowFrom: account.allowFrom,
              policyPath: `channels.${id}.accounts.${key}.dmPolicy`,
              allowFromPath: `channels.${id}.accounts.${key}.`,
              approveHint: `approve ${key}`,
            }
          : null;
      },
      ...(dmRouting ? { dmRouting } : {}),
    },
  } satisfies ChannelPlugin;
}

function collect(
  cfg: OpenClawConfig,
  plugins: ChannelPlugin | ChannelPlugin[],
  mode?: "audit" | "doctor",
) {
  return collectChannelSecurityFindingsCore({
    cfg,
    plugins: Array.isArray(plugins) ? plugins : [plugins],
    mode,
  });
}

function dmBinding(id: string, dmScope: DmScope, accountId?: string) {
  return {
    agentId: "main",
    match: {
      channel: "whatsapp",
      peer: { kind: "direct" as const, id },
      ...(accountId ? { accountId } : {}),
    },
    session: { dmScope },
  };
}

describe("security audit channel dm policy", () => {
  it("reports unowned DM routes without losing sibling findings in audit mode", async () => {
    const findings = await collect(
      {
        agents: { entries: { main: {}, research: {} } },
        bindings: [{ agentId: "research", match: { channel: "whatsapp", accountId: "owned" } }],
      },
      createDmPlugin({
        finite: { allowFrom: ["user-a", "user-b"] },
        open: openAccount(),
        owned: { allowFrom: ["user-c", "user-d"] },
      }),
      "audit",
    );

    for (const account of ["finite", "open"]) {
      expect(
        getFinding(findings, `channels.whatsapp.routing.owner_missing.${account}`),
      ).toMatchObject({
        severity: "warn",
        remediation: expect.stringContaining(`whatsapp:${account}`),
      });
    }
    expect(
      findings.filter((finding) => finding.checkId.includes(".routing.owner_missing.")),
    ).toHaveLength(2);
    expect(getFinding(findings, "channels.whatsapp.dm.open")?.severity).toBe("critical");
    expect(collisionFindings(findings)).toHaveLength(1);
    expect(collisionFindings(findings)[0]?.detail).toContain("owned");
  });

  it("keeps producer-owned channel severity through the audit summary", async () => {
    const checkId = "channels.whatsapp.test.open_access";
    const disabledAccounts = { default: { policy: "disabled", allowFrom: [] } };
    const plugin = createDmPlugin(disabledAccounts);
    plugin.security.collectWarnings = () => [
      {
        checkId,
        severity: "critical",
        title: "warning",
        detail: "open access",
      },
    ];

    const auditOptions = { config: {}, includeFilesystem: false } as const;
    const baseline = await runSecurityAuditCore({
      ...auditOptions,
      plugins: [createDmPlugin(disabledAccounts)],
    });
    const report = await runSecurityAuditCore({ ...auditOptions, plugins: [plugin] });

    expect(getFinding(report.findings, checkId)).toMatchObject({
      severity: "critical",
      detail: "open access",
    });
    expect(report.summary.critical).toBe(baseline.summary.critical + 1);
  });

  it.each<{
    name: string;
    cfg: OpenClawConfig;
    plugins: ChannelPlugin | ChannelPlugin[];
    expected: Record<string, unknown>[];
  }>`
    name                                                   | cfg                                                                                                                                                                                                                         | plugins                                                                                                                                                                            | expected
    ${"identity-linked aliases"}                           | ${{ session: { ...mainSession, identityLinks: { alice: ["whatsapp:user-a", "whatsapp:user-b"] } } }}                                                                                                                        | ${createDmPlugin()}                                                                                                                                                                | ${[]}
    ${"distinct principals"}                               | ${{ session: mainSession }}                                                                                                                                                                                                 | ${createDmPlugin()}                                                                                                                                                                | ${[{}]}
    ${"separate collision topologies"}                     | ${{ agents: { entries: { alpha: {}, beta: {} } }, session: mainSession, bindings: ["a", "b", "c", "d"].map((accountId, index) => ({ agentId: index < 2 ? "alpha" : "beta", match: { channel: "whatsapp", accountId } })) }} | ${createDmPlugin(Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { allowFrom: [`user-${id}`] }])))}                                                                       | ${[{}, {}]}
    ${"per-channel wildcard intersects a concrete sender"} | ${{ session: { dmScope: "per-channel-peer" } }}                                                                                                                                                                             | ${createDmPlugin({ open: openAccount(), finite: { allowFrom: ["user-b"] } }, { resolveDmRoute: ({ principalId }) => (principalId === undefined ? { kind: "core" } : undefined) })} | ${[mayShare]}
    ${"per-peer wildcard subsumes a per-channel wildcard"} | ${{}}                                                                                                                                                                                                                       | ${(["whatsapp", "telegram"] as const).map((id) => createDmPlugin({ open: openAccount() }, { resolveDmScope: () => (id === "whatsapp" ? "per-peer" : "per-channel-peer") }, id))}   | ${[mayShare]}
    ${"finite probes cannot hide an open-DM collision"}    | ${{ session: mainSession, bindings: [1, 2].map((n) => dmBinding(`__openclaw_audit_unmatched_dm_${n}__`, "per-channel-peer")) }}                                                                                             | ${createDmPlugin({ default: openAccount() })}                                                                                                                                      | ${[{}]}
    ${"exact DM bindings admitted by wildcard policy"}     | ${{ session: { dmScope: "per-account-channel-peer" }, bindings: [dmBinding("bound-a", "main", "*"), dmBinding("bound-b", "main", " WORK ")] }}                                                                              | ${createDmPlugin({ work: openAccount() })}                                                                                                                                         | ${[{ title: "DM principals share a session", detail: expect.stringContaining("2 distinct admitted DM principals") }]}
  `("audits collision topology for $name", async ({ cfg, plugins, expected }) => {
    const findings = await collect(cfg, plugins);
    const collisions = collisionFindings(findings);
    expect(collisions).toEqual(expected.map((shape) => expect.objectContaining(shape)));
    if (expected.length > 1) {
      expect(new Set(collisions.map((finding) => finding.checkId)).size).toBe(2);
      expect(new Set(collisions.map((finding) => finding.detail)).size).toBe(2);
    }
  });

  it("warns when custom finite routing omits an unknown-principal policy", async () => {
    const findings = await collect(
      { session: mainSession },
      createDmPlugin(
        { default: openAccount() },
        {
          resolveDmRoute: ({ principalId, route }) =>
            principalId === undefined ? undefined : { sessionKey: route.sessionKey },
        },
      ),
    );

    const finding = getFinding(
      findings,
      "channels.whatsapp.dm.wildcard_routing_unverified.default",
    );
    expect(finding?.detail).toContain("resolveDmRoute returned no unknown-principal policy");
  });
});
