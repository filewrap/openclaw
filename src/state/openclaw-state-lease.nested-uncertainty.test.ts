import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import * as leaseStorage from "./openclaw-state-lease-storage.js";
import { withOpenClawStateLeaseWorkerAdmission as withAdmission } from "./openclaw-state-lease-worker-owner.js";
import { OpenClawStateLeaseError, withOpenClawStateLease } from "./openclaw-state-lease.js";

const fixture = vi.hoisted(() => ({
  expiresAt: 40_000,
  loseRenewal: false,
  release: vi.fn(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Nested uncertainty controls must not open SQLite or heartbeat workers");
  }),
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  createOpenClawStateLeaseWorkerStorage: fixture.forbiddenNative,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  prepareLeaseDatabase: fixture.forbiddenNative,
  resolveLeaseDatabasePath: () => "/synthetic-state/lease.sqlite",
  verifyOpenClawStateLeaseOwnership: () => fixture.expiresAt,
  renewOpenClawStateLease: () => {
    if (fixture.loseRenewal) {
      throw new OpenClawStateLeaseError("Synthetic lease ownership was lost", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
    }
    fixture.expiresAt = Date.now() + 30_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseBestEffort: async () => fixture.release(),
  releaseOpenClawStateLease: fixture.release,
}));
vi.mock("./openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: fixture.forbiddenNative,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.expiresAt = 40_000;
  fixture.loseRenewal = false;
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

describe("native lease admission", () => {
  const options = {
    scope: "projects.checkout",
    key: "synthetic-checkout",
    database: { scope: "shared" as const },
    leaseMs: 1_000,
    waitMs: 0,
  };
  beforeEach(() => {
    fixture.expiresAt = 10_000;
    vi.setSystemTime(9_000);
    vi.spyOn(leaseStorage, "verifyOpenClawStateLeaseOwnership").mockImplementation(() => {
      if (Date.now() >= fixture.expiresAt) {
        throw new OpenClawStateLeaseError("Synthetic lease ownership expired", {
          code: "OPENCLAW_STATE_LEASE_LOST",
        });
      }
      return fixture.expiresAt;
    });
    vi.spyOn(leaseStorage, "renewOpenClawStateLease").mockImplementation(() => {
      fixture.expiresAt = Date.now() + 1_000;
      return fixture.expiresAt;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a lease with a worker expiry 30 days ahead alive", async () => {
    fixture.expiresAt = Date.now() + 30 * 24 * 60 * 60_000;
    await withOpenClawStateLease(options, async (lease) => {
      await vi.advanceTimersByTimeAsync(100);
      expect(lease.signal.aborted).toBe(false);
      lease.assertOwned();
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "expired", "renewed"] as const)(
    "gates effects on a %s native lease",
    async (state) => {
      const effect = vi.fn();
      const operation = withOpenClawStateLease(options, async (lease) =>
        withAdmission(lease, "/synthetic-state/lease.sqlite", async (admission) => {
          if (state === "renewed") {
            vi.setSystemTime(9_500);
            lease.renew?.();
          }
          // Change only the clock; the queued expiry callback has not run.
          vi.setSystemTime(state === "live" ? 9_999 : 10_000);
          admission.assertCurrent();
          effect();
        }),
      );
      if (state === "expired") {
        await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      } else {
        await operation;
      }
      expect(effect).toHaveBeenCalledTimes(state === "expired" ? 0 : 1);
    },
  );
});

afterEach(() => {
  try {
    expect(fixture.forbiddenNative).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

async function failUnderAuthority(
  failure: unknown,
  authority: "none" | "loss" | "abort" | "loss and abort" = "none",
) {
  const caller = new AbortController();
  const abortCause = new Error("Caller canceled the outer operation");
  let loss: unknown;
  const error: unknown = await withOpenClawStateLease(
    {
      scope: "core:test",
      key: "nested-uncertainty",
      database: { scope: "shared", options: { path: "/synthetic-state/lease.sqlite" } },
      leaseMs: 30_000,
      waitMs: 0,
      signal: authority === "none" ? undefined : caller.signal,
    },
    async (lease) => {
      if (authority === "loss" || authority === "loss and abort") {
        fixture.loseRenewal = true;
        // Drive the real owner's renewal callback against the fake store.
        vi.advanceTimersByTime(10_000);
        expect(lease.signal.aborted).toBe(true);
        loss = lease.signal.reason;
        expect(loss).toBeInstanceOf(OpenClawStateLeaseError);
        expect(loss).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      }
      if (authority === "abort" || authority === "loss and abort") {
        caller.abort(abortCause);
        expect(caller.signal.aborted).toBe(true);
      }
      throw failure;
    },
  ).then(
    () => assert.fail("Lease operation unexpectedly succeeded"),
    (reason: unknown) => reason,
  );
  expect(fixture.release).toHaveBeenCalledOnce();
  return { error, loss, abortCause };
}

it.each([
  { shape: "direct", authority: "none" },
  { shape: "structured", authority: "none" },
  { shape: "direct", authority: "loss" },
  { shape: "cause", authority: "abort" },
  { shape: "aggregate", authority: "loss and abort" },
  { shape: "known", authority: "none" },
  { shape: "known", authority: "loss" },
  { shape: "known", authority: "abort" },
] as const)("preserves $shape failure under $authority authority", async ({ shape, authority }) => {
  const unknown = new SqliteWorkerError("Nested write outcome is unknown", "outcome-unknown");
  const sibling = new Error("Sibling cleanup failed");
  const failure = {
    known: new Error("Known failure"),
    structured: { code: "outcome-unknown", message: "Unknown outcome" },
    cause: new Error("Nested failure", { cause: unknown }),
    aggregate: new AggregateError([sibling, unknown], "Nested failures"),
    direct: unknown,
  }[shape];
  const { error, loss, abortCause } = await failUnderAuthority(failure, authority);
  if (shape === "known") {
    if (authority === "abort") {
      expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED", cause: abortCause });
    } else {
      expect(error).toBe(authority === "loss" ? loss : failure);
    }
    return;
  }
  expect(error).toMatchObject({ code: "outcome-unknown" });
  if (shape === "structured") {
    expect(error).toBeInstanceOf(SqliteWorkerError);
    expect(error).toMatchObject({ cause: failure });
  } else if (authority === "none") {
    expect(error).toBe(failure);
  } else {
    const causes = collectNestedErrorCandidates(error);
    for (const cause of [unknown, failure, ...(shape === "aggregate" ? [sibling] : [])]) {
      expect(causes).toContain(cause);
    }
    if (authority === "abort") {
      expect(causes).toContain(abortCause);
      expect(causes).toContainEqual(
        expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_ABORTED", cause: abortCause }),
      );
    } else {
      // Lease loss takes precedence when both authorities fire.
      expect(causes).toContain(loss);
    }
  }
});
