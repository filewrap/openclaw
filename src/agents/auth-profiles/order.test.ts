import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { isAmbientCredentialAllowedByProviderAuthPin } from "./ambient-auth.js";
import { createBedrockAwsSdkConfig } from "./config-fixtures.test-support.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential as oauth,
  createUnresolvedOAuthRefCredential,
} from "./credential-fixtures.test-support.js";
import { closeAuthProfileReadPool } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

const pluginMetadataMocks = vi.hoisted(() => {
  vi.resetModules();
  const snapshot = {
    plugins: [
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
      },
    ],
    diagnostics: [],
  };
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

vi.mock("./external-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./external-auth.js")>()),
  createExternalAuthRuntime: () => ({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: <T>(store: T) => store,
  }),
}));

import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  resolveAuthProfileOrderWithMetadata,
} from "./order.js";
import { markAuthProfileSuccess } from "./profiles.js";

function storeWith(
  profiles: AuthProfileStore["profiles"],
  rest: Omit<Partial<AuthProfileStore>, "profiles"> = {},
): AuthProfileStore {
  return { version: 1, profiles, ...rest };
}

const fixtureProvider = "fixture-provider";
const key = (name: string) => createApiKeyCredential(fixtureProvider, `sk-${name}`);
const fixtureProfileId = (name: string) => `${fixtureProvider}:${name}`;
const keyStore = (names: string[], rest: Omit<Partial<AuthProfileStore>, "profiles"> = {}) =>
  storeWith(Object.fromEntries(names.map((name) => [fixtureProfileId(name), key(name)])), rest);
type OrderOptions = Omit<Parameters<typeof resolveAuthProfileOrder>[0], "provider" | "store">;
const order = (store: AuthProfileStore, extra: OrderOptions = {}) =>
  resolveAuthProfileOrder({ provider: fixtureProvider, store, ...extra });
const metadata = (store: AuthProfileStore, extra: OrderOptions = {}) =>
  resolveAuthProfileOrderWithMetadata({ provider: fixtureProvider, store, ...extra });
const configuredOrder = (...ids: string[]): OpenClawConfig => ({
  auth: { order: { [fixtureProvider]: ids.map(fixtureProfileId) } },
});

describe("resolveAuthProfileOrder", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockClear();
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("includes pending OAuth refresh only for settlement-aware runtime resolution", () => {
    const profileId = "openai:pending";
    const pending = createOAuthRefreshFence({
      profileId,
      credential: oauth({ expires: 1, accountId: "acct-a" }),
    });
    const failed = createFailedOAuthRefreshFence(pending);
    const incompatibleConfig: OpenClawConfig = {
      auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" } } },
    };
    for (const [credential, provider, includePendingOAuthRefresh, cfg, expected] of [
      [pending, "openai", undefined, undefined, []],
      [pending, "openai", true, undefined, [profileId]],
      [failed, "openai", true, undefined, []],
      [pending, "anthropic", true, undefined, []],
      [pending, "openai", true, incompatibleConfig, []],
    ] as const) {
      expect(
        resolveAuthProfileOrder({
          cfg,
          store: { version: 1, profiles: { [profileId]: credential } },
          provider,
          includePendingOAuthRefresh,
        }),
      ).toEqual(expected);
    }
  });

  it("applies provider auth pins to ambient credentials through auth aliases", () => {
    const cfg = {
      models: {
        providers: {
          "fixture-provider": { auth: "oauth", baseUrl: "https://example.invalid", models: [] },
          "fixture-provider-plan": { baseUrl: "https://example.invalid", models: [] },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      isAmbientCredentialAllowedByProviderAuthPin({
        config: cfg,
        provider: "fixture-provider-plan",
        type: "api_key",
      }),
    ).toBe(false);
  });

  it("keeps configured AWS SDK profiles eligible without stored credentials", () => {
    const cfg = createBedrockAwsSdkConfig();
    const store = storeWith({});

    expect(
      resolveAuthProfileEligibility({
        cfg,
        store,
        provider: "amazon-bedrock",
        profileId: "amazon-bedrock:default",
      }),
    ).toEqual({ eligible: true, reasonCode: "ok" });
    expect(resolveAuthProfileOrder({ cfg, store, provider: "amazon-bedrock" })).toEqual([
      "amazon-bedrock:default",
    ]);
  });

  it("falls back to stored profiles when a stored order only has missing credentials", async () => {
    const store = storeWith(
      {
        "fixture-provider:key": key("primary"),
        "fixture-provider:oauth": oauth({ provider: "fixture-provider" }),
      },
      { order: { "fixture-provider": ["fixture-provider:deleted"] } },
    );

    expect(order(store)).toStrictEqual(["fixture-provider:oauth", "fixture-provider:key"]);
  });

  it("prefers live OAuth before expired OAuth", () => {
    const now = Date.now();
    expect(
      resolveAuthProfileOrder({
        store: storeWith(
          {
            "openai:valid": oauth({ expires: now + 60_000 }),
            "openai:expired": oauth({ expires: now - 60_000 }),
          },
          {
            usageStats: {
              "openai:expired": { lastUsed: 0 },
              "openai:valid": { lastUsed: 10_000 },
            },
          },
        ),
        provider: "openai",
      }),
    ).toStrictEqual(["openai:valid", "openai:expired"]);
  });

  it.each(["read-only", "execution"] as const)(
    "orders expired and active cooldowns in %s mode without read-only housekeeping",
    (readinessMode) => {
      const active = fixtureProfileId("active"),
        expired = fixtureProfileId("expired"),
        ready = fixtureProfileId("ready");
      const expiredAt = Date.now() - 60_000;
      const activeUntil = Date.now() + 600_000;
      const store = keyStore(["active", "expired", "ready"], {
        usageStats: {
          [active]: { lastUsed: 0, cooldownUntil: activeUntil },
          [expired]: {
            lastUsed: 20,
            cooldownUntil: expiredAt,
            cooldownReason: "timeout",
            errorCount: 3,
          },
          [ready]: { lastUsed: 10 },
        },
      });

      expect(metadata(store, { readinessMode })).toEqual({
        profileIds: [ready, expired, active],
        hasExplicitOrder: false,
      });
      const { lastUsed, cooldownUntil, cooldownReason, errorCount } =
        store.usageStats?.[expired] ?? {};
      expect({ lastUsed, cooldownUntil, cooldownReason, errorCount }).toEqual({
        lastUsed: 20,
        cooldownUntil: readinessMode === "read-only" ? expiredAt : undefined,
        cooldownReason: readinessMode === "read-only" ? "timeout" : undefined,
        errorCount: readinessMode === "read-only" ? 3 : 0,
      });
      expect(store.usageStats?.[active]?.cooldownUntil).toBe(activeUntil);
    },
  );

  it("does not fall back past an explicit configured auth order", async () => {
    const store = keyStore(["primary"]);

    const cfg = configuredOrder("missing");
    expect(order(store, { cfg })).toStrictEqual([]);
    expect(metadata(store, { cfg })).toStrictEqual({
      profileIds: [],
      hasExplicitOrder: true,
    });
  });

  it.each(["cooldown", "block"] as const)(
    "does not apply a %s scoped to another model when ordering profiles",
    (kind) => {
      const primary = fixtureProfileId("primary"),
        backup = fixtureProfileId("backup");
      const store = keyStore(["primary", "backup"], {
        usageStats: {
          [primary]:
            kind === "cooldown"
              ? {
                  cooldownUntil: Date.now() + 60_000,
                  cooldownReason: "rate_limit",
                  cooldownModel: "model-a",
                }
              : {
                  blockedUntil: Date.now() + 60_000,
                  blockedReason: "subscription_limit",
                  blockedModel: "model-a",
                  blockedScope: "model",
                },
        },
      });
      const cfg = configuredOrder("primary", "backup");

      expect(order(store, { cfg, forModel: "model-b" })).toStrictEqual([primary, backup]);
      expect(order(store, { cfg, forModel: "model-a" })).toStrictEqual([backup, primary]);
    },
  );

  it("keeps unresolved OAuth refs only in read-only profile ordering", () => {
    const store = storeWith({
      "openai:legacy-ref": createUnresolvedOAuthRefCredential(),
    });

    expect(resolveAuthProfileOrderWithMetadata({ store, provider: "openai" })).toEqual({
      profileIds: [],
      hasExplicitOrder: false,
    });
    expect(
      resolveAuthProfileOrderWithMetadata({
        store,
        provider: "openai",
        readinessMode: "read-only",
      }),
    ).toEqual({ profileIds: ["openai:legacy-ref"], hasExplicitOrder: false });
  });

  it("discovers OpenAI OAuth profiles before API-key backups", async () => {
    const store = storeWith({
      "openai:personal": oauth(),
      "openai:backup": createApiKeyCredential("openai", "sk-platform"),
      "openai:oauth": oauth(),
    });

    expect(resolveAuthProfileOrder({ store, provider: "openai" })).toEqual([
      "openai:personal",
      "openai:oauth",
      "openai:backup",
    ]);
  });

  it("does not discover OAuth profiles without inline credential material", async () => {
    const store = storeWith({ "openai:personal": oauth({ access: "", refresh: "" }) });

    expect(resolveAuthProfileOrder({ store, provider: "openai" })).toEqual([]);
  });

  it("marks profile success with one canonical last-good and usage update", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-success-"));
    try {
      const store = storeWith(
        {
          "fixture-provider:default": oauth({ provider: "fixture-provider" }),
        },
        {
          usageStats: {
            "fixture-provider:default": {
              errorCount: 3,
              blockedUntil: Date.now() + 120_000,
              blockedReason: "subscription_limit",
              cooldownUntil: Date.now() + 60_000,
              cooldownReason: "rate_limit",
            },
          },
        },
      );
      saveAuthProfileStore(store, agentDir);

      const beforeSuccess = Date.now();
      await markAuthProfileSuccess({
        store,
        provider: "fixture-provider-plan",
        profileId: "fixture-provider:default",
        agentDir,
      });
      const afterSuccess = Date.now();

      expect(store.lastGood).toEqual({
        "fixture-provider": "fixture-provider:default",
      });
      const { errorCount, blockedUntil, blockedReason, cooldownUntil, cooldownReason } =
        store.usageStats?.["fixture-provider:default"] ?? {};
      expect({ errorCount, blockedUntil, blockedReason, cooldownUntil, cooldownReason }).toEqual({
        errorCount: 0,
        blockedUntil: undefined,
        blockedReason: undefined,
        cooldownUntil: undefined,
        cooldownReason: undefined,
      });
      const lastUsed = store.usageStats?.["fixture-provider:default"]?.lastUsed;
      expect(typeof lastUsed).toBe("number");
      expect(lastUsed).toBeGreaterThanOrEqual(beforeSuccess);
      expect(lastUsed).toBeLessThanOrEqual(afterSuccess);
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
      await closeOpenClawAgentDatabasesAsync(agentDir);
      await rm(agentDir, { force: true, recursive: true });
    }
  });

  it("keeps provider identity and configured mode distinct", () => {
    const credential = { type: "token", provider: "openai", token: "test-token" } as const;
    const authAliasLookupParams = { metadataSnapshot: { plugins: [] } };
    const store: AuthProfileStore = { version: 1, profiles: { fixture: credential } };
    const params = {
      store,
      profileId: "fixture",
      provider: "openai",
      authAliasLookupParams,
      now: 1_700_000_000_000,
    };

    expect(
      isStoredCredentialCompatibleWithAuthProvider({
        provider: "other-provider",
        credential,
        authAliasLookupParams,
      }),
    ).toBe(false);
    expect(
      resolveAuthProfileEligibility({
        ...params,
        cfg: {
          auth: {
            profiles: { fixture: { provider: "other-provider", mode: credential.type } },
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: "provider_mismatch" });
    expect(
      resolveAuthProfileEligibility({
        ...params,
        cfg: {
          auth: { profiles: { fixture: { provider: "openai", mode: "oauth" } } },
        },
      }),
    ).toEqual({ eligible: true, reasonCode: "ok" });
  });
});
