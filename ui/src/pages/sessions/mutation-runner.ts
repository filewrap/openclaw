import type { SessionsPageRequestScope } from "./request-scope.ts";
import type { SessionsPageMutationResult } from "./sessions-page-state.types.ts";

export function createSessionsMutationRunner(host: {
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  settled: (outcome: SessionsPageMutationResult | void) => void;
}) {
  let pending = false;
  return {
    get pending() {
      return pending;
    },
    retire() {
      pending = false;
    },
    async run(
      scope: SessionsPageRequestScope,
      mutate: () => Promise<SessionsPageMutationResult | void>,
    ): Promise<SessionsPageMutationResult | void> {
      pending = true;
      let outcome: SessionsPageMutationResult | void = undefined;
      try {
        outcome = await mutate();
      } catch (error) {
        outcome = { status: "failed", error };
      } finally {
        if (host.isCurrent(scope)) {
          pending = false;
          host.settled(outcome);
        }
      }
      return host.isCurrent(scope) ? outcome : "stale";
    },
  };
}
