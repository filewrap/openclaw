import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

const exposure = "security.exposure.open_groups_with_";
const multiUser = "security.trust_model.multi_user_heuristic";
const groupScope = "security.trust_model.group_scope_main";
const elevated = exposure + "elevated";
const runtime = exposure + "runtime_or_fs";
const control = exposure + "control_plane_tools";
const critical = { severity: "critical" };
const warn = { severity: "warn" };
const disabled = { elevated: { enabled: false } };
function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}
function channel(
  channels: OpenClawConfig["channels"],
  tools: OpenClawConfig["tools"] = disabled,
): OpenClawConfig {
  return { channels, tools };
}
function openGroup(
  tools: OpenClawConfig["tools"] = {},
  agents?: OpenClawConfig["agents"],
): OpenClawConfig {
  return { ...channel({ whatsapp: { groupPolicy: "open" } }, { ...disabled, ...tools }), agents };
}
function openDm(tools: OpenClawConfig["tools"]): OpenClawConfig {
  return channel({ slack: { dmPolicy: "open" } }, { ...disabled, ...tools });
}
type Binding = NonNullable<OpenClawConfig["bindings"]>[number];
function room(agentId: string, scope: "main" | "per-group", kind?: "group" | "channel"): Binding {
  return {
    agentId,
    match: {
      channel: "discord",
      accountId: "work",
      ...(kind ? { peer: { kind, id: "room-1" } } : {}),
    },
    session: { groupScope: scope },
  };
}
const bindings = (...entries: Binding[]): OpenClawConfig => ({ bindings: entries });
type Expected = {
  severity?: string;
  title?: string;
  detail?: string[];
  notDetail?: string[];
  remediation?: string[];
  notRemediation?: string[];
};
function check(cfg: OpenClawConfig, id: string, expected: Expected = {}) {
  const finding = audit(cfg).find((entry) => entry.checkId === id);
  expect(finding, id).toBeDefined();
  const { detail, notDetail, remediation, notRemediation, ...match } = expected;
  expect(finding).toMatchObject(match);
  for (const [value, includes, excludes] of [
    [finding?.detail, detail, notDetail],
    [finding?.remediation, remediation, notRemediation],
  ] as const) {
    for (const text of includes ?? []) {
      expect(value).toContain(text);
    }
    for (const text of excludes ?? []) {
      expect(value).not.toContain(text);
    }
  }
}
function absent(cfg: OpenClawConfig, ...ids: string[]) {
  const findings = audit(cfg);
  for (const checkId of ids) {
    expect(findings).not.toContainEqual(expect.objectContaining({ checkId }));
  }
}

describe("security audit trust model findings", () => {
  it.each([
    { name: "inherited", groupPolicy: undefined, expected: true },
    { name: "explicitly disabled", groupPolicy: "disabled", expected: false },
  ] as const)("audits account group targets with $name policy", ({ groupPolicy, expected }) => {
    const findings = collectLikelyMultiUserSetupFindings({
      channels: {
        discord: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              ...(groupPolicy ? { groupPolicy } : {}),
              guilds: { "1234567890": {} },
            },
          },
        },
      },
    });
    const finding = findings.find((entry) => entry.checkId === multiUser);
    expect(Boolean(finding)).toBe(expected);
    if (expected) {
      expect(finding?.detail).toContain(
        'channels.discord.accounts.work.groupPolicy="allowlist" with configured group targets',
      );
    }
  });

  it("evaluates trust-model exposure findings", () => {
    check(
      openGroup({ elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } }),
      elevated,
      critical,
    );
    check(openGroup(), runtime, critical);
    absent(openGroup({ profile: "coding" }, { defaults: { sandbox: { mode: "all" } } }), runtime);
    absent(
      openGroup({ profile: "coding", deny: ["group:runtime"], fs: { workspaceOnly: true } }),
      runtime,
    );
    check(
      channel({
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "1234567890": { channels: { "7777777777": { enabled: true } } },
          },
        },
      }),
      multiUser,
      {
        ...warn,
        detail: [
          'channels.discord.groupPolicy="allowlist" with configured group targets',
          "personal-assistant",
          "https://docs.openclaw.ai/gateway/security/trust-model",
        ],
        remediation: ['agents.defaults.sandbox.mode="all"'],
      },
    );
    absent(channel({ discord: { groupPolicy: "allowlist" } }), multiUser, groupScope);
    check({ session: { groupScope: "main" } }, groupScope, {
      ...warn,
      title: "Group rooms share the main session",
      detail: ['session.groupScope="main"', "all group/channel rooms"],
      remediation: ["https://docs.openclaw.ai/channels/groups#session-keys"],
    });
    check(
      {
        session: { groupScope: "per-group" },
        ...bindings({
          agentId: "support",
          match: {
            channel: "discord",
            accountId: "work",
            peer: { kind: "channel", id: "1234567890" },
            guildId: "9876543210",
            roles: ["operators", "reviewers"],
          },
          session: { groupScope: "main" },
        }),
      },
      groupScope,
      {
        ...warn,
        detail: [
          "discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers",
        ],
        notDetail: ["all group/channel rooms"],
      },
    );
    absent(
      bindings({
        agentId: "support",
        match: { channel: "whatsapp", peer: { kind: "direct", id: "user-a" } },
        session: { groupScope: "main" },
      }),
      groupScope,
    );
    absent(
      bindings(room("isolated", "per-group", "group"), room("shared", "main", "channel")),
      groupScope,
    );
    check(
      bindings(room("shared", "main", "channel"), room("isolated", "per-group", "group")),
      groupScope,
      { detail: ["discord accountId=work peer=channel:room-1"] },
    );
    check(bindings(room("isolated", "per-group"), room("shared", "main", "group")), groupScope, {
      detail: ["discord accountId=work peer=group:room-1"],
    });
    const dm = { feishu: { groupPolicy: "disabled", dmPolicy: "open" } } as const;
    check(
      channel(dm, { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } }),
      elevated,
      { ...critical, detail: ["channels.feishu.dmPolicy"] },
    );
    check(channel(dm, { ...disabled, profile: "coding" }), runtime, {
      ...critical,
      detail: ["channels.feishu.dmPolicy"],
    });
    check(
      {
        channels: { discord: { dmPolicy: "allowlist", accounts: { work: { dmPolicy: "open" } } } },
      },
      elevated,
      {
        detail: ["channels.discord.accounts.work.dmPolicy"],
        notDetail: ["channels.discord.dmPolicy"],
      },
    );
    check(
      { channels: { discord: { dm: { policy: "open" } } } } as unknown as OpenClawConfig,
      elevated,
      { detail: ["channels.discord.dm.policy"] },
    );
    check({ channels: { matrix: { dm: { policy: "open" } } } }, elevated, {
      detail: ["channels.matrix.dm.policy"],
      remediation: ["each listed group/DM policy"],
      notRemediation: ["dmPolicy"],
    });
    const canonical = audit({
      channels: { discord: { dmPolicy: "allowlist", dm: { policy: "open" } } },
    } as unknown as OpenClawConfig);
    expect(
      canonical.some((entry) => entry.checkId.startsWith("security.exposure.open_groups_")),
    ).toBe(false);
    check(openGroup({ profile: "coding" }), control, {
      ...critical,
      detail: ["channels.whatsapp.groupPolicy", "controlPlane=[automations, gateway, plugins]"],
      remediation: ["`plugins`"],
    });
    check(openDm({ allow: ["gateway"] }), control, {
      ...critical,
      detail: ["channels.slack.dmPolicy", "controlPlane=[gateway]"],
    });
    check(openDm({ profile: "messaging", alsoAllow: ["cron"] }), control, {
      detail: ["agents.defaults (profile=messaging; controlPlane=[automations, gateway])"],
    });
    check(
      openGroup(
        { profile: "messaging" },
        { entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } } },
      ),
      control,
      {
        detail: [
          "agents.entries.ops (profile=messaging; controlPlane=[gateway])",
          "agents.defaults (profile=messaging; controlPlane=[gateway])",
        ],
      },
    );
    absent(openGroup({ profile: "coding", deny: ["gateway", "cron", "plugins"] }), control);
    absent(openGroup({ allow: ["nodes", "computer"] }), control);
    absent(
      channel({ whatsapp: { groupPolicy: "allowlist" } }, { ...disabled, profile: "coding" }),
      control,
    );
  });
});
