import { createMemo, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginAskAction } from "./overview.tsx";
import { pluginRowKey } from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";
type PluginLifecycleProps = {
  plugin: PluginCatalogItem;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  busy: Readonly<Record<string, PluginMutationAction>>;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onSettings: () => void;
  settingsHref: string;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onAskPlugin?: () => void;
};
function LifecycleAction(props: {
  kind: PluginMutationAction;
  label: string;
  class: string;
  blockedReason: string | null;
  allowed: boolean;
  pending: PluginMutationAction | undefined;
  pluginName: string;
  onClick: () => void;
}) {
  return (
    <ReasonedDisabledControl reason={props.blockedReason}>
      <button
        type="button"
        class={["btn oc-action", props.class]}
        disabled={!props.blockedReason && (!props.allowed || Boolean(props.pending))}
        aria-disabled={!props.allowed || props.pending ? "true" : undefined}
        aria-label={`${props.label} ${props.pluginName}`}
        aria-busy={props.pending === props.kind ? "true" : undefined}
        onClick={() => {
          if (props.allowed && !props.pending) {
            props.onClick();
          }
        }}
      >
        {props.pending === props.kind ? <span class="btn__spinner" aria-hidden="true" /> : null}
        {props.label}
      </button>
    </ReasonedDisabledControl>
  );
}
export function PluginLifecycle(props: PluginLifecycleProps) {
  const key = () => pluginRowKey(props.plugin.id);
  const pending = () => props.busy[key()];
  const enableAction = createMemo(() => {
    const action = pending();
    return action === "enable" || action === "disable"
      ? action
      : props.plugin.enabled
        ? "disable"
        : "enable";
  });
  // Keep the primary action first in visual and keyboard navigation order.
  return (
    <>
      <Show when={props.plugin.enabled && props.onAskPlugin}>
        {(onAsk) => renderPluginAskAction(() => onAsk()(), true)}
      </Show>
      <LifecycleAction
        kind={enableAction()}
        label={t(
          enableAction() === "disable" ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable",
        )}
        class={props.plugin.enabled ? "oc-action-secondary" : "primary oc-action-primary"}
        blockedReason={
          props.mutationBlockedReason ??
          (props.plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null)
        }
        allowed={props.canMutate && props.plugin.state !== "needs-setup"}
        pending={pending()}
        pluginName={props.plugin.name}
        onClick={() => props.onSetEnabled(props.plugin.id, !props.plugin.enabled, key())}
      />
      <Show when={!props.plugin.enabled && props.onAskPlugin}>
        {(onAsk) => renderPluginAskAction(() => onAsk()(), false)}
      </Show>
      <Show when={props.plugin.removable}>
        <LifecycleAction
          kind="uninstall"
          label={t("pluginsPage.uninstall")}
          class="oc-action-secondary"
          blockedReason={props.mutationBlockedReason}
          allowed={props.canMutate}
          pending={pending()}
          pluginName={props.plugin.name}
          onClick={() => props.onUninstall(props.plugin.id, key())}
        />
      </Show>
      <a
        class="btn btn--icon oc-action oc-action-icon oc-action-secondary"
        href={props.settingsHref}
        aria-label={t("pluginsPage.detailSettings")}
        onClick={(event: MouseEvent) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
            props.onSettings();
          }
        }}
      >
        <Icon name="settings" />
      </a>
    </>
  );
}
