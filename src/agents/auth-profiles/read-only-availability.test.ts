import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAuthStoreReadOnlyValidUntil,
  resolveStoredCredentialReadOnlyAvailability,
} from "./read-only-availability.js";
import type { AuthProfileStore } from "./types.js";

const cfg = { secrets: { providers: { vault: { source: "env" } } } } satisfies OpenClawConfig;
const missingRef = (id: string) => ({ source: "env" as const, provider: "vault", id });
type AvailabilityParams = Parameters<typeof resolveStoredCredentialReadOnlyAvailability>[0];
const apiKey = (
  keyRef: Extract<AvailabilityParams["credential"], { type: "api_key" }>["keyRef"],
) => ({
  type: "api_key" as const,
  provider: "test",
  key: "kept",
  keyRef,
});
const token = (
  overrides: Partial<Extract<AvailabilityParams["credential"], { type: "token" }>> = {},
) => ({
  type: "token" as const,
  provider: "test",
  token: "kept",
  ...overrides,
});
function expectAvailability(
  credential: AvailabilityParams["credential"],
  options: Partial<Omit<AvailabilityParams, "credential">> = {},
) {
  return expect(
    resolveStoredCredentialReadOnlyAvailability({ credential, cfg, env: {}, ...options }),
  );
}

describe("resolveAuthStoreReadOnlyValidUntil", () => {
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      token: token({ expires: 150 }),
      oauth: {
        type: "oauth",
        provider: "test",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 125,
      },
      undated: token(),
    },
    usageStats: {
      blocked: { blockedUntil: 200 },
      cooling: { cooldownUntil: 250 },
      disabled: { disabledUntil: 300 },
    },
  };

  it("selects the next static-token or failure-window expiry", () => {
    expect(resolveAuthStoreReadOnlyValidUntil(store, 100)).toBe(150);
  });

  it("keeps an empty store valid without an expiry", () => {
    expect(resolveAuthStoreReadOnlyValidUntil({ version: 1, profiles: {} }, 100)).toBe(Infinity);
  });
});

describe("resolveStoredCredentialReadOnlyAvailability", () => {
  it.each([
    [true, true],
    [false, false],
  ])("preserves env availability under a file collision (selected=%s)", (selected, expected) => {
    expectAvailability(apiKey({ source: "env", provider: "selected", id: "COLLISION_KEY" }), {
      cfg: {
        secrets: {
          defaults: selected ? { env: "selected" } : undefined,
          providers: { selected: { source: "file", path: "/unused" } },
        },
      },
      env: { COLLISION_KEY: "synthetic-key" },
    }).toBe(expected);
  });

  it.each([
    [true, undefined],
    [false, false],
  ] as const)(
    "classifies token store refs without resolving them (selected=%s)",
    (selected, expected) => {
      expectAvailability(
        token({ tokenRef: { source: "store", provider: "shared", id: "STORED_API_KEY" } }),
        {
          cfg: {
            secrets: {
              defaults: selected ? { store: "shared" } : undefined,
              providers: { shared: { source: "file", path: "/tmp/unused.json" } },
            },
          },
        },
      ).toBe(expected);
    },
  );

  it("prefers explicit secret refs over retained inline values", () => {
    expectAvailability(apiKey(missingRef("MISSING_KEY"))).toBeUndefined();
    expectAvailability(token({ tokenRef: missingRef("MISSING_TOKEN") })).toBeUndefined();
  });

  it("rejects expired static tokens before checking their secret ref", () => {
    const now = Date.now();
    expectAvailability(token({ tokenRef: missingRef("MISSING_TOKEN"), expires: now }), {
      now,
    }).toBe(false);
    expectAvailability(token({ expires: "invalid" as never }), { now }).toBe(false);
  });

  it("requires an explicit provider refresh capability for refresh-only OAuth", () => {
    const credential = {
      type: "oauth" as const,
      provider: "test",
      access: "",
      refresh: "refresh",
      expires: 0,
    };
    expectAvailability(credential).toBeUndefined();
    expectAvailability(credential, { canRefreshOAuth: true }).toBe(true);
  });
});
