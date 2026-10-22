import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

type SlashConfig = { slashCommand?: { enabled?: boolean }; allowFrom?: unknown };

const makeSlackHttpConfig = (): OpenClawConfig => ({
  channels: {
    slack: { enabled: true, mode: "http", groupPolicy: "open", slashCommand: { enabled: true } },
  },
});

type InspectionOverrides = Partial<{
  enabled: boolean;
  configured: boolean;
  botTokenStatus: string;
  signingSecretStatus: string;
}>;

function makeSlackInspection(channel: SlashConfig, overrides: InspectionOverrides) {
  return {
    enabled: true,
    configured: true,
    botTokenStatus: "configured_unavailable",
    signingSecretStatus: "configured_unavailable",
    config: channel,
    ...overrides,
  };
}

describe("security audit channel source-config fallback slack", () => {
  it.each<{
    name: string;
    source: InspectionOverrides;
    resolved: InspectionOverrides;
    selected: "source" | "resolved";
  }>`
    name                                                       | source                | resolved                                                                              | selected
    ${"resolved inspection only exposes signingSecret status"} | ${{ enabled: false }} | ${{ botTokenStatus: "available", signingSecretStatus: "available" }}                  | ${"resolved"}
    ${"source wins when resolved inspection is unconfigured"}  | ${{}}                 | ${{ configured: false, botTokenStatus: "available", signingSecretStatus: "missing" }} | ${"source"}
  `("keeps source-configured findings: $name", async ({ source, resolved, selected }) => {
    const cfg = makeSlackHttpConfig();
    const sourceConfig = makeSlackHttpConfig();
    const inspections = {
      source: makeSlackInspection(sourceConfig.channels?.slack ?? {}, source),
      resolved: makeSlackInspection(cfg.channels?.slack ?? {}, resolved),
    };
    const findings = await collectChannelSecurityFindingsCore({
      cfg,
      sourceConfig,
      plugins: [
        stubAuditChannelPlugin({
          id: "slack",
          label: "Slack",
          commands: { nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false },
          collectAuditFindings: async ({ account }) => {
            expect(account).toBe(inspections[selected]);
            expect(inspections[selected].config.slashCommand).toEqual({ enabled: true });
            expect(inspections[selected].config.allowFrom ?? []).toEqual([]);
            return [
              {
                checkId: "channels.slack.commands.slash.no_allowlists",
                severity: "warn",
                title: "Slack slash commands have no allowlists",
                detail: "test stub",
              },
            ];
          },
          inspectAccount: (input) => inspections[input === sourceConfig ? "source" : "resolved"],
          resolveAccount: (input) => ({ config: input.channels?.slack ?? {} }),
          isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
        }),
      ],
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "channels.slack.commands.slash.no_allowlists",
        severity: "warn",
      }),
    );
  });
});
