import { racePromiseWithAbortSignal } from "@openclaw/retry";
import { action, createOptimistic, createSignal, untrack } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { InputDialogOptions } from "./input-dialog-types.ts";

export function InputDialogView(props: {
  options: InputDialogOptions;
  finish(value: string | null): void;
  settled: () => boolean;
}) {
  // A prompt keeps its submitted request and default for its entire lifetime.
  const initialOptions = untrack(() => props.options);
  const gateway = initialOptions.gateway ? projectGateway(initialOptions.gateway) : undefined;
  let input!: HTMLInputElement;
  // Submission admission stays synchronous; signals publish the visible state.
  let submitting = false;
  const [busy, setBusy] = createOptimistic(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const presentSubmission = action(function* (
    pending: Promise<string | null>,
  ): Generator<Promise<string | null>, string | null, string | null> {
    if (!props.settled()) {
      setBusy(true);
    }
    return yield pending;
  });
  const [rawValue, setRawValue] = createSignal(initialOptions.defaultValue ?? "");
  const entryValue = (raw: string) => (initialOptions.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    const connected = gateway?.read().snapshot.phase === "connected";
    const canSubmit = initialOptions.canSubmit?.();
    return (
      canSubmit === false ||
      (gateway !== undefined && !connected && canSubmit !== true) ||
      (initialOptions.requireValue === true && !value.length) ||
      (initialOptions.requireChange === true && value === (initialOptions.defaultValue ?? ""))
    );
  };
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.settled() || submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    const submitValue = initialOptions.submit;
    if (!submitValue) {
      props.finish(value);
      return;
    }
    submitting = true;
    setFailure(null);
    let message: string | null;
    try {
      const pending = racePromiseWithAbortSignal(() => submitValue(value), initialOptions.signal);
      // Commit the owner's admission before the presentation action opens its transaction.
      await Promise.resolve();
      message = await presentSubmission(pending);
    } catch (error) {
      message = formatUiError(error);
    }
    if (props.settled()) {
      return;
    }
    submitting = false;
    if (message === null) {
      props.finish(value);
      return;
    }
    setFailure(message);
    // The view update re-enables the input before restoring its editing focus.
    queueMicrotask(() => {
      if (!props.settled()) {
        input.focus();
      }
    });
  }
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => input}
      label={initialOptions.title}
      description={initialOptions.label ?? initialOptions.title}
      onModal-cancel={(event: Event) => {
        if (submitting) {
          event.preventDefault();
        } else {
          props.finish(null);
        }
      }}
    >
      <form
        class="exec-approval-card"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div class="exec-approval-header">
          <div class="exec-approval-title">{initialOptions.title}</div>
        </div>
        <label class="field input-dialog__field">
          <span>{initialOptions.label ?? initialOptions.title}</span>
          <input
            ref={(element) => {
              input = element;
            }}
            name="value"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value={rawValue()}
            disabled={busy()}
            aria-invalid={failure() ? "true" : undefined}
            onInput={(event) => setRawValue(event.currentTarget.value)}
            autofocus
          />
        </label>
        {failure() ? (
          <div class="exec-approval-error" role="alert">
            {failure()}
          </div>
        ) : undefined}
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn" disabled={busy()} onClick={() => props.finish(null)}>
            {initialOptions.cancelLabel ?? t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" disabled={busy() || submitBlocked(rawValue())}>
            {initialOptions.submitLabel ?? t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
