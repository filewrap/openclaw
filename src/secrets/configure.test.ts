import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryMock = vi.hoisted(() => vi.fn());
const runSecretsApplyMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: selectMock,
  text: vi.fn(),
  log: { warn: vi.fn() },
}));

vi.mock("./config-io.js", () => ({
  createSecretsConfigIO: (...args: unknown[]) => createSecretsConfigIOMock(...args),
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (...args: unknown[]) => loadPersistedAuthProfileStoreMock(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

vi.mock("./apply.js", () => ({
  runSecretsApply: (...args: unknown[]) => runSecretsApplyMock(...args),
}));

const { runSecretsConfigureInteractive } = await import("./configure.js");

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-configure-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

describe("runSecretsConfigureInteractive", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset();
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });
    loadPersistedAuthProfileStoreMock.mockReset();
    loadPluginManifestRegistryMock.mockReset().mockReturnValue({ diagnostics: [], plugins: [] });
    runSecretsApplyMock.mockReset().mockResolvedValue({
      changed: true,
      changedFiles: [],
      warningCount: 0,
      warnings: [],
      checks: { resolvabilityComplete: true },
      skippedExecRefs: 0,
    });
  });

  it("does not load auth-profiles when running providers-only", async () => {
    selectMock.mockResolvedValue("continue");
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("adds a plugin preset provider through providers-only configure", async () => {
    const pluginRoot = makeTempDir();
    const resolverPath = path.join(pluginRoot, "vault-secret-ref-resolver.js");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n");
    fs.chmodSync(resolverPath, 0o600);
    selectMock.mockResolvedValueOnce("preset");
    selectMock.mockImplementationOnce(({ options }) => options[0].value);
    selectMock.mockResolvedValueOnce("continue");
    loadPluginManifestRegistryMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "vault",
          name: "Vault",
          origin: "global",
          rootDir: pluginRoot,
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              displayName: "HashiCorp Vault",
              source: "exec",
              command: "${node}",
              args: ["./vault-secret-ref-resolver.js"],
              passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
              timeoutMs: 5000,
            },
          },
        },
      ],
    });

    const vault = {
      source: "exec",
      pluginIntegration: { pluginId: "vault", integrationId: "vault" },
    };
    const result = await runSecretsConfigureInteractive({ providersOnly: true, env: {} });
    expect([result.plan.targets, result.plan.providerUpserts?.vault]).toEqual([[], vault]);
    expect(runSecretsApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          providerUpserts: expect.objectContaining({
            vault: expect.objectContaining({ source: "exec" }),
          }),
        }),
        write: false,
        allowExec: false,
      }),
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });
});
