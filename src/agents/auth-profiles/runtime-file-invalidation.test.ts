import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearSnapshots,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath as getSnapshot,
  registerRuntimeAuthProfileExternalRefresh as onRefresh,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath as publishSnapshot,
} from "./runtime-snapshots.js";
import type { AuthProfileStore } from "./types.js";

const observation = vi.hoisted<{
  onChange?: (change: {
    directory: string;
    identityChanged: boolean;
    sourcesChanged: boolean;
    createdPaths: readonly string[];
  }) => void | Promise<void>;
}>(() => ({}));

// mock-isolation: Supply file events without native watches to prove snapshot retirement and refresh settlement.
vi.mock("./file-state.js", () => ({
  noteAuthProfileFileWrite() {},
  refreshAuthProfileFileState: async () => {},
  authProfileSourceExists: () => false,
  readAuthProfileDatabaseIdentity: vi.fn(),
  captureAuthProfileFileIdentity: vi.fn(),
  authProfileFileChanges: observation,
}));

const sharedDatabase = "/tmp/auth-file-invalidation/shared/openclaw-agent.sqlite";
const agentDatabase = "/tmp/auth-file-invalidation/agent/openclaw-agent.sqlite";

function publishAgent(key: string): void {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { example: { type: "api_key", provider: "example", key } },
  };
  publishSnapshot(store, agentDatabase, path.dirname(agentDatabase), {
    databasePath: agentDatabase,
    sharedDatabasePath: sharedDatabase,
    location: "legacy-main",
  });
}

function observeSharedReplacement(): void {
  void observation.onChange?.({
    directory: path.dirname(sharedDatabase),
    identityChanged: true,
    sourcesChanged: false,
    createdPaths: [],
  });
}

beforeEach(clearSnapshots);
afterEach(clearSnapshots);

it("retires an inherited snapshot when its shared database changes without a shared snapshot", async () => {
  const refreshed = Promise.withResolvers<boolean>();
  onRefresh(() => refreshed.promise);
  publishAgent("inherited");
  expect(getSnapshot(sharedDatabase)).toBeUndefined();
  expect(getSnapshot(agentDatabase)).toBeDefined();

  observeSharedReplacement();

  expect(getSnapshot(agentDatabase)).toBeUndefined();
  refreshed.resolve(true);
  await refreshed.promise;
});

it.each([
  { outcome: "declined", reset: true },
  { outcome: "failed", reset: true },
  { outcome: "declined", reset: false },
  { outcome: "failed", reset: false },
] as const)(
  "keeps newer snapshots when external refresh $outcome (reset: $reset)",
  async ({ outcome, reset }) => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<boolean>();
    onRefresh(() => {
      started.resolve();
      return refreshed.promise;
    });
    publishAgent("before");
    observeSharedReplacement();
    await started.promise;

    if (reset) {
      clearSnapshots();
    }
    publishAgent("replacement");
    if (outcome === "declined") {
      refreshed.resolve(false);
    } else {
      refreshed.reject(new Error("Previous lifecycle refresh failed"));
    }
    await refreshed.promise.catch(() => undefined);

    expect(getSnapshot(agentDatabase)?.profiles.example).toEqual({
      type: "api_key",
      provider: "example",
      key: "replacement",
    });
  },
);

it.each([false, true])(
  "retains first-file snapshots only with known source provenance: %s",
  async (knownSource) => {
    onRefresh(async () => true);
    publishAgent("inherited");
    if (knownSource) {
      runtimeAuthProfileRowsCache.recordSource(sharedDatabase, "absent", null);
    }
    await observation.onChange?.({
      directory: path.dirname(sharedDatabase),
      identityChanged: false,
      sourcesChanged: false,
      createdPaths: [sharedDatabase],
    });
    expect(getSnapshot(agentDatabase) !== undefined).toBe(knownSource);
  },
);
