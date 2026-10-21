import type { SessionsPageOwner } from "./sessions-page-state.ts";
import type { SessionsPageMutationResult } from "./sessions-page-state.types.ts";

type View = ReturnType<SessionsPageOwner["view"]>;
type OptionalFields =
  | "labelDisabledReason"
  | "patchAdminDisabledReason"
  | "groupWriteDisabledReason"
  | "deleteArchivedDisabledReason"
  | "deleteSelectedDisabledReason";

export type SessionsProps = Omit<View, OptionalFields | "sessionMenu"> &
  Partial<Pick<View, OptionalFields>> & {
    sessionMenu: { key: string } | null;
    commandPending?: boolean;
    commandCompletion?: Promise<SessionsPageMutationResult | void> | null;
  };
