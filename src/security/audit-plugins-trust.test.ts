import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { collectPluginsTrustFindings } from "./audit-plugins-trust.js";

const mockChannelPlugins = vi.hoisted(() => [
  {
    id: "discord",
    capabilities: {},
    commands: {},
    config: { listAccountIds: () => [], resolveAccount: () => null },
  },
]);
const mockPluginRegistryIds = vi.hoisted(() => ["anthropic", "discord", "some-plugin"]);
const mockPluginTools = vi.hoisted(() => ({ names: ["some_plugin_tool"] as string[] | undefined }));

const readInstalledPackageVersionMock = vi.hoisted(() =>
  vi.fn(async (dir: string): Promise<string | undefined> => {
    if (dir.includes("/extensions/voice-call") || dir.includes("\\extensions\\voice-call")) {
      return "9.9.9";
    }
    if (dir.includes("/hooks/test-hooks") || dir.includes("\\hooks\\test-hooks")) {
      return "8.8.8";
    }
    return undefined;
  }),
);

vi.mock("../infra/package-update-utils.js", () => ({
  readInstalledPackageVersion: readInstalledPackageVersionMock,
}));

// mock-isolation: Use explicit fixture enablement without loading plugin runtime state.
vi.mock("../plugins/config-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/config-state.js")>()),
  normalizePluginsConfig: (config: OpenClawConfig["plugins"]) => ({
    allow: config?.allow ?? [],
    deny: config?.deny ?? [],
    enabled: config?.enabled !== false,
    entries: config?.entries ?? {},
  }),
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  createPluginRegistryIdNormalizer: () => (id: string) => id,
  loadPluginRegistrySnapshot: () => ({
    diagnostics: [],
    plugins: mockPluginRegistryIds.map((pluginId) => ({
      pluginId,
      contributions:
        pluginId === "some-plugin" && mockPluginTools.names !== undefined
          ? { contracts: { tools: mockPluginTools.names } }
          : undefined,
    })),
  }),
}));

// mock-isolation: Trust findings use fixture channels without loading installed channel runtimes.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfigAsync: async () => mockChannelPlugins,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => null,
}));

describe("security audit install metadata findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  const makeTmpDir = async (label: string, extensions: string[] = []) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    for (const name of extensions) {
      await fs.mkdir(path.join(dir, "extensions", name), { recursive: true });
    }
    return dir;
  };

  const runInstallMetadataAudit = (cfg: OpenClawConfig, stateDir: string) =>
    collectPluginsTrustFindings({ cfg, stateDir });

  const writeHookInstalls = (
    stateDir: string,
    installs: Record<string, HookInstallRecord>,
  ): void => {
    writeConfigMachineState("hooks.internal.installs", installs, {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  };

  const requireInstallFinding = (
    findings: Awaited<ReturnType<typeof runInstallMetadataAudit>>,
    checkId: string,
  ) =>
    expectDefined(
      findings.find((entry) => entry.checkId === checkId),
      checkId,
    );

  const writePluginIndexInstallRecords = async (
    stateDir: string,
    records: Record<string, PluginInstallRecord>,
  ) => {
    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "2026.4.25",
      compatRegistryVersion: "compat",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: Date.now(),
      installRecords: records,
      plugins: [],
      diagnostics: [],
    };
    await writePersistedInstalledPluginIndex(index, { stateDir });
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-install-"));
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
  });

  afterAll(async () => {
    // Fixture writers and audit readers share one SQLite owner; close it before removing files.
    await closeOpenClawStateDatabaseAsync();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each<{
    name: string;
    flags: Partial<Record<"pinned" | "integrity" | "resolved" | "drift", boolean>>;
    present: string[];
    absent: string[];
  }>`
    name                        | flags                                             | present                                        | absent
    ${"unpinned"}               | ${{}}                                             | ${["unpinned_npm_specs", "missing_integrity"]} | ${[]}
    ${"pinned"}                 | ${{ pinned: true, integrity: true }}              | ${[]}                                          | ${["unpinned_npm_specs", "missing_integrity"]}
    ${"unpinned with metadata"} | ${{ integrity: true, resolved: true }}            | ${["unpinned_npm_specs"]}                      | ${["missing_integrity"]}
    ${"version drift"}          | ${{ pinned: true, integrity: true, drift: true }} | ${["version_drift"]}                           | ${[]}
  `("audits $name install records", async ({ name, flags, present, absent }) => {
    const stateDir = await makeTmpDir(name);
    const record = (packageName: string, integrity: string): HookInstallRecord => ({
      source: "npm",
      spec: `@openclaw/${packageName}${flags.pinned ? "@1.2.3" : ""}`,
      ...(flags.integrity ? { integrity } : {}),
      ...(flags.resolved ? { resolvedSpec: `@openclaw/${packageName}@1.2.3` } : {}),
      ...(flags.drift ? { resolvedVersion: "1.2.3" } : {}),
    });
    await writePluginIndexInstallRecords(stateDir, {
      "voice-call": record("voice-call", "sha512-plugin"),
    });
    writeHookInstalls(stateDir, { "test-hooks": record("test-hooks", "sha512-hook") });
    const findings = await runInstallMetadataAudit({}, stateDir);
    for (const owner of ["plugins", "hooks"]) {
      for (const suffix of present) {
        expect(findings, name).toContainEqual(
          expect.objectContaining({ checkId: `${owner}.installs_${suffix}`, severity: "warn" }),
        );
      }
      for (const suffix of absent) {
        expect(
          findings.some(({ checkId }) => checkId === `${owner}.installs_${suffix}`),
          name,
        ).toBe(false);
      }
    }
  });

  it("keeps install metadata precedence and reads hooks after plugin versions", async () => {
    const stateDir = await makeTmpDir("install-metadata-order");
    const pluginPath = path.join(stateDir, "custom-plugin");
    const hookPath = path.join(stateDir, "hooks", "test-hooks");
    await writePluginIndexInstallRecords(stateDir, {
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: pluginPath,
        version: "0.9.0",
        resolvedVersion: "1.0.0",
      },
      "empty-version": {
        source: "npm",
        spec: "@openclaw/empty-version@1.0.0",
        integrity: "sha512-empty",
        version: "1.0.0",
        resolvedVersion: "",
      },
      "local-plugin": { source: "path", spec: "local-plugin", version: "1.0.0" },
    });
    writeHookInstalls(stateDir, {
      "old-hooks": { source: "npm", spec: "old-hooks", version: "1.0.0" },
    });

    const reads: string[] = [];
    await readInstalledPackageVersionMock.withImplementation(
      async (dir) => {
        reads.push(dir);
        if (dir === pluginPath) {
          writeHookInstalls(stateDir, {
            "test-hooks": {
              source: "npm",
              spec: "@openclaw/test-hooks",
              integrity: " ",
              version: "2.0.0",
            },
          });
          return "1.1.0";
        }
        return dir === hookPath ? "2.1.0" : undefined;
      },
      async () => {
        const findings = await runInstallMetadataAudit({}, stateDir);
        // Persistence drops blank resolved versions and sorts plugin IDs before the audit reads them.
        expect(reads).toEqual([
          path.join(stateDir, "extensions", "empty-version"),
          pluginPath,
          hookPath,
        ]);
        expect(findings.map(({ checkId }) => checkId)).toEqual(
          ["plugins", "hooks"].flatMap((owner) =>
            ["unpinned_npm_specs", "missing_integrity", "version_drift"].map(
              (suffix) => `${owner}.installs_${suffix}`,
            ),
          ),
        );
        expect(findings.map(({ detail }) => detail)).toEqual([
          "Unpinned plugin index install records:\n- voice-call (@openclaw/voice-call)",
          "Plugin index records missing integrity:\n- voice-call",
          "Detected plugin install metadata drift:\n- voice-call (recorded 1.0.0, installed 1.1.0)",
          "Unpinned hook install records:\n- test-hooks (@openclaw/test-hooks)",
          "Hook install records missing integrity:\n- test-hooks",
          "Detected hook install metadata drift:\n- test-hooks (recorded 2.0.0, installed 2.1.0)",
        ]);
        expect(findings.map(({ remediation }) => remediation)).toEqual([
          "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
          "Reinstall or update plugins to refresh install metadata with resolved integrity hashes.",
          "Run `openclaw plugins update --all` (or reinstall affected plugins) to refresh install metadata.",
          "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
          "Reinstall or update hooks to refresh install metadata with resolved integrity hashes.",
          "Run `openclaw hooks update --all` (or reinstall affected hooks) to refresh install metadata.",
        ]);
      },
    );
  });

  it.each<{ installed: string; allow: string[]; phantom: string }>`
    installed                  | allow                                                | phantom
    ${"some-installed-plugin"} | ${["discord", "anthropic", "some-installed-plugin"]} | ${""}
    ${"installed-plugin"}      | ${["installed-plugin", "ghost-plugin-xyz"]}          | ${"ghost-plugin-xyz"}
  `("audits phantom entries beside $installed", async ({ installed, allow, phantom }) => {
    const stateDir = await makeTmpDir("phantom", [installed]);
    const findings = await runInstallMetadataAudit({ plugins: { allow } }, stateDir);
    const finding = findings.find(({ checkId }) => checkId === "plugins.allow_phantom_entries");
    if (!phantom) {
      expect(finding).toBeUndefined();
    } else {
      expect(expectDefined(finding, "phantom entry")).toMatchObject({ severity: "warn" });
      expect(finding?.detail).toContain(phantom);
      expect(finding?.detail).not.toContain(installed);
    }
  });

  it("ignores install backup and debris dirs when auditing installed plugin roots", async () => {
    const stateDir = await makeTmpDir("installed-plugin-debris", [
      "live-plugin",
      ".openclaw-install-backups",
      "node_modules",
      "old-plugin.backup-20260502",
      "old-plugin.disabled.20260502",
      "old-plugin.bak",
    ]);

    const findings = await runInstallMetadataAudit({}, stateDir);

    const noAllowlist = requireInstallFinding(findings, "plugins.extensions_no_allowlist");
    expect(noAllowlist.detail).toContain("Found 1 extension(s)");

    const toolsReachable = requireInstallFinding(
      findings,
      "plugins.tools_reachable_permissive_policy",
    );
    expect(toolsReachable.detail).toContain("Enabled extension plugins: live-plugin.");
    expect(findings.map((finding) => finding.detail).join("\n")).not.toContain(
      ".openclaw-install-backups",
    );
  });
  const reachable = "plugins.tools_reachable_permissive_policy";
  const declared = ["some_plugin_tool"];
  const allowed: OpenClawConfig = { plugins: { allow: ["some-plugin"] } };
  const grouped: OpenClawConfig = {
    ...allowed,
    tools: { profile: "coding", alsoAllow: ["group:plugins"] },
  };
  const agentScoped: OpenClawConfig = {
    ...allowed,
    agents: { entries: { ops: { tools: { profile: "full" } } } },
  };
  const denied: OpenClawConfig = { ...grouped, tools: { ...grouped.tools, deny: declared } };
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    tools: string[] | undefined;
    checkId: string | false;
    detail: string;
  }>`
    name                  | cfg                                             | tools        | checkId                              | detail
    ${"no allowlist"}     | ${{}}                                           | ${declared}  | ${"plugins.extensions_no_allowlist"} | ${""}
    ${"permissive"}       | ${allowed}                                      | ${declared}  | ${reachable}                         | ${""}
    ${"agent scope"}      | ${agentScoped}                                  | ${declared}  | ${reachable}                         | ${"- agents.entries.ops"}
    ${"restrictive"}      | ${{ ...allowed, tools: { profile: "coding" } }} | ${declared}  | ${false}                             | ${""}
    ${"plugin group"}     | ${grouped}                                      | ${declared}  | ${reachable}                         | ${""}
    ${"missing contract"} | ${grouped}                                      | ${undefined} | ${reachable}                         | ${""}
    ${"empty contract"}   | ${allowed}                                      | ${[]}        | ${false}                             | ${""}
    ${"concrete deny"}    | ${denied}                                       | ${declared}  | ${false}                             | ${""}
  `("audits extension tools: $name", async ({ name, cfg, tools, checkId, detail }) => {
    const root = await makeTmpDir("reachability");
    const home = path.join(root, "home");
    const stateDir = path.join(root, "shared-extensions-state");
    const isolatedEnv = createPathResolutionEnv(home, { OPENCLAW_HOME: home });
    const scopedEnv = Object.fromEntries(
      [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
      ].map((key) => [key, isolatedEnv[key]]),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(stateDir, "extensions", "some-plugin"), {
        recursive: true,
        mode: 0o700,
      });
      await withEnvAsync(scopedEnv, async () => {
        mockPluginTools.names = tools;
        const findings = await collectPluginsTrustFindings({ cfg, stateDir });
        if (checkId) {
          expect(findings, name).toContainEqual(
            expect.objectContaining({ checkId, severity: "warn" }),
          );
        } else {
          expect(
            findings.some((entry) => entry.checkId === reachable),
            name,
          ).toBe(false);
        }
        if (detail) {
          expect(findings.find((entry) => entry.checkId === reachable)?.detail).toContain(detail);
        }
      });
    } finally {
      homedirSpy.mockRestore();
    }
  });
});
