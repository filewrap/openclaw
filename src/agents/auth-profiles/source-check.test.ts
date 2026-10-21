import fs from "node:fs/promises";
import path from "node:path";
import { aroundEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createApiKeyCredential as credential,
  createAuthProfileStoreFixture,
} from "./credential-fixtures.test-support.js";
import { refreshAuthProfileFileState } from "./file-state.js";
import {
  assertAuthProfileMigrationReady as assertReady,
  AuthProfileMigrationRequiredError,
  clearAuthProfileMigrationDiagnostics,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import { hasAuthProfileStoreSourceForProvider } from "./source-check.js";
import { readPersistedAuthProfileStoreRaw, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { loadAuthProfileStoreForRuntime, updateAuthProfileStoreWithLock } from "./store-runtime.js";

let agentDir: string;
const apiKey = { type: "api_key", provider: "openai", key: "sk-test" };
const unreadable = { version: 1, profiles: "invalid-profile-map" };
const write = (profiles: unknown) =>
  writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir);
const load = () => loadAuthProfileStoreForRuntime(agentDir);
const hasSource = (profileIds?: readonly string[]) =>
  hasAuthProfileStoreSourceForProvider("openai", agentDir, { profileIds });
const writeLegacy = (profiles: unknown) =>
  fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(profiles));

aroundEach((runTest) =>
  withTestDir({ prefix: "openclaw-auth-source-" }, async (root) => {
    const stateDir = path.join(root, "state");
    agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await runTest();
    } finally {
      clearAuthProfileMigrationDiagnostics();
      await cleanupSessionStateForTest({ stateDir, rootPath: root });
      vi.unstubAllEnvs();
    }
  }),
);

it.each([
  [
    "malformed providers",
    {
      "openai:default": { type: "api_key", key: "sk-test" },
      "openai:other": { ...apiKey, provider: 123 },
    },
  ],
  ["empty credentials", { "openai:default": { type: "api_key", provider: "openai" } }],
] as const)("ignores %s as credential evidence", (_name, profiles) => {
  write(profiles);
  expect(hasSource()).toBe(false);
});

it("routes structurally unreadable SQLite rows through the fail-closed loader", () => {
  write({});
  writePersistedAuthProfileStoreRaw(unreadable, agentDir);
  expect(hasSource()).toBe(true);
  expect(load).toThrow("is unreadable");
});

it("rejects unreadable rows inside write transactions without invoking the updater", async () => {
  write({});
  writePersistedAuthProfileStoreRaw(unreadable, agentDir);
  const updater = vi.fn(() => true);
  await expect(updateAuthProfileStoreWithLock({ agentDir, updater })).rejects.toThrow(
    "is unreadable; run openclaw doctor --fix",
  );
  expect(updater).not.toHaveBeenCalled();
  expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadable);
});

it("returns null for classified SQLite lock contention", async () => {
  write({});
  const updater = () => {
    throw Object.assign(new Error("database is locked"), { errcode: 5 });
  };
  await expect(updateAuthProfileStoreWithLock({ agentDir, updater })).resolves.toBeNull();
});

it("detects late legacy aliases and retires their migrated source", async () => {
  write({});
  expect(load().profiles).toEqual({});
  await writeLegacy({ openai: { mode: "apiKey", apiKey: "sk-test" } });
  await refreshAuthProfileFileState();
  expect(hasSource()).toBe(true);
  expect(load).toThrow("requires legacy credential migration");
  await fs.rename(path.join(agentDir, "auth.json"), path.join(agentDir, "auth.json.migrated"));
  await refreshAuthProfileFileState();
  clearAuthProfileMigrationDiagnostics();
  expect(load().profiles).toEqual({});
});

it.each([
  ["expired then usable", [["openai:expired"], ["openai:default"]], [false, true]],
  ["explicitly empty", [[]], [false]],
] as const)("honors %s configured profile order", (_name, orders, expected) => {
  write({
    "openai:default": apiKey,
    "openai:expired": {
      type: "token",
      provider: "openai",
      token: "expired",
      expires: Date.now() - 1000,
    },
  });
  expect(orders.map(hasSource)).toEqual(expected);
});

const canonicalEntry = (profile: Record<string, unknown>, id = "anthropic:default") =>
  JSON.stringify(createAuthProfileStoreFixture({ [id]: profile }));
const legacyOAuth = { type: "oauth", provider: "openai-codex", access: "a", refresh: "r" };

describe("assertAuthProfileMigrationReady", () => {
  it("retains recorded provider refusals across repeated lifecycle marks", async () => {
    const legacyPath = path.join(agentDir, "auth-profiles.json");
    for (const provider of ["anthropic", "nvidia"]) {
      await fs.writeFile(legacyPath, JSON.stringify({ [provider]: { apiKey: "legacy-key" } }));
      markAuthProfileMigrationRequired(
        agentDir,
        new AuthProfileMigrationRequiredError({
          agentDir,
          sources: [{ kind: "auth-profiles", path: legacyPath }],
        }),
      );
    }
    await fs.rm(legacyPath);
    for (const provider of ["anthropic", "nvidia"]) {
      expect(() => assertReady(agentDir, undefined, provider)).toThrow(
        "affected providers: anthropic, nvidia",
      );
    }
    expect(() => assertReady(agentDir, undefined, "litellm")).not.toThrow();
  });

  it.each([
    ["canonical", canonicalEntry(credential("anthropic", "legacy-key")), true],
    ["flat", JSON.stringify({ anthropic: { apiKey: "legacy-key" } }), true],
    ["legacy OpenAI provider", canonicalEntry(legacyOAuth, "openai-codex:default"), true, "openai"],
    ["malformed JSON", "{broken", false],
    ["metadata-only flat object", '{"metadata":{}}', false],
    ["unknown flat fields", '{"anthropic":{"unknown":"value"},"openai":{"other":true}}', false],
    ["mixed flat metadata", '{"anthropic":{"apiKey":"synthetic-key"},"metadata":{}}', false],
    [
      "unrecognized canonical entry",
      '{"profiles":{"anthropic:default":{"provider":"anthropic","unknown":true}}}',
      false,
    ],
    ["missing provider", canonicalEntry({ type: "api_key", key: "legacy-key" }), false],
  ] as const)(
    "preserves migration safety for %s sources",
    async (_name, raw, scoped, blockedProvider?: string) => {
      const legacyPath = path.join(agentDir, "auth-profiles.json");
      await fs.writeFile(legacyPath, raw);
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
      const ready = (provider?: string) => () => assertReady(agentDir, undefined, provider);
      const unscoped = "affected providers: all (legacy provider scope unavailable)";
      if (scoped) {
        expect(ready("litellm")).not.toThrow();
      } else {
        expect(ready("litellm")).toThrow(unscoped);
        expect(ready("openai")).toThrow(unscoped);
      }
      expect(ready(blockedProvider ?? "anthropic")).toThrow("run openclaw doctor --fix");
      // An unscoped operation still cannot publish or mutate this owner.
      expect(ready()).toThrow("requires legacy credential migration");
      expect(await fs.readFile(legacyPath, "utf8")).toBe(raw);
    },
  );

  it("reports only credential sources without marking runtime migration state", async () => {
    const root = agentDir;
    const credentialAgentDir = path.join(root, "credential-agent");
    const authStateAgentDir = path.join(root, "auth-state-agent");
    await fs.mkdir(credentialAgentDir, { recursive: true });
    await fs.mkdir(authStateAgentDir, { recursive: true });
    const credentialPath = path.join(credentialAgentDir, "auth-profiles.json");
    await fs.writeFile(credentialPath, "{}\n");
    await fs.writeFile(path.join(authStateAgentDir, "auth-state.json"), "{}\n");

    // An auth-state file carries no credentials, so it never blocks its owner.
    expect(() => assertReady(authStateAgentDir)).not.toThrow();
    expect(() => assertReady(credentialAgentDir)).toThrow("requires legacy credential migration");
    clearAuthProfileMigrationDiagnostics();

    await fs.rm(credentialPath);
    await refreshAuthProfileFileState();
    expect(() => assertReady(credentialAgentDir)).not.toThrow();
  });
});
