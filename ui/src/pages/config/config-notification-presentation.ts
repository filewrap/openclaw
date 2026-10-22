import type * as Push from "../../../../packages/gateway-protocol/src/schema/push.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";

/** Presents notification owners; command admission and outcomes remain with them. */
export function createConfigNotificationPresentation(context: ApplicationContext) {
  const webPush = projectOwner(context.webPush, (owner) => owner.snapshot);
  const native = context.nativeNotifications
    ? projectOwner(context.nativeNotifications, (owner) => owner.snapshot)
    : null;
  let lifetime = Promise.withResolvers<void>();
  function retire() {
    // Release presentation before a reactive scope change can park its cleanup.
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  return {
    retire,
    dispose() {
      lifetime.resolve();
    },
    subscribeRoute() {
      let location = context.router.getState().location;
      return context.router.subscribe(() => {
        const next = context.router.getState().location;
        if (
          next.pathname !== location.pathname ||
          next.search !== location.search ||
          next.hash !== location.hash
        ) {
          location = next;
          retire();
        }
      });
    },
    props() {
      return {
        presentationRetired: () => lifetime.promise,
        nativeNotifications: native?.read(),
        onNativeNotificationsRequestPermission: () =>
          context.nativeNotifications?.requestPermission(),
        onNativeNotificationsSendTest: () => context.nativeNotifications?.sendTest(),
        // Downstream equality checks need a new value for the mutable owner snapshot.
        webPush: { ...webPush.read() },
        onWebPushSubscribe: () => context.webPush.run({ kind: "enable" }),
        onWebPushUnsubscribe: () => context.webPush.run({ kind: "disable" }),
        onWebPushTest: () => context.webPush.run({ kind: "test" }),
        onWebPushSetUserPreferences: (preferences: Push.WebPushNotificationPreferences) =>
          context.webPush.run({ kind: "set", scope: "user", preferences }),
        onWebPushSetDevicePreferences: (preferences: Push.WebPushDevicePreferences) =>
          context.webPush.run({ kind: "set", scope: "device", preferences }),
      };
    },
  };
}
