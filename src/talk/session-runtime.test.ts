import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCallbacks,
  type RealtimeVoiceBridgeCreateRequest,
} from "./provider-types.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSessionParams,
} from "./session-runtime.js";
import { makeBridge, makeVoiceProvider } from "./session-runtime.test-support.js";

const toolCall = { itemId: "item-1", callId: "call-1", name: "lookup", args: {} };

function createSession(
  options: Partial<RealtimeVoiceBridgeSessionParams> = {},
  bridgeOverrides: Partial<RealtimeVoiceBridge> = {},
  onCreate?: (request: RealtimeVoiceBridgeCreateRequest) => void,
) {
  let callbacks!: RealtimeVoiceBridgeCreateRequest;
  const bridge = makeBridge(bridgeOverrides);
  const session = createRealtimeVoiceBridgeSession({
    provider: makeVoiceProvider((request) => {
      callbacks = request;
      onCreate?.(request);
      return bridge;
    }),
    providerConfig: {},
    audioSink: { sendAudio: vi.fn() },
    ...options,
  });
  return { session, callbacks, bridge };
}

describe("realtime voice bridge session runtime", () => {
  it.each(["abort", "detach", "cancelled-detach"] as const)(
    "settles accepted native delegation after %s while rejecting new work",
    async (ending) => {
      const completion = createDeferred<{ text: string }>();
      const consult = vi.fn(() => completion.promise);
      const close = vi.fn();
      const { session, callbacks } = createSession({ runAgentConsult: consult }, { close });
      const runner = callbacks.runAgentConsult;
      expect(runner).toBeTypeOf("function");
      const controller = new AbortController();
      const signal = controller.signal;
      const pending = runner!({ prompt: "Check the agenda", signal });
      expect(consult).toHaveBeenCalledExactlyOnceWith({ prompt: "Check the agenda", signal });
      const settled =
        ending === "detach"
          ? expect(pending).resolves.toEqual({ text: "Late answer" })
          : expect(pending).rejects.toThrow(
              ending === "abort" ? "session is closed" : "Call cancelled",
            );
      await session.close({ disposition: ending === "abort" ? "abort" : "detach" });
      expect(close).toHaveBeenCalledExactlyOnceWith({
        disposition: ending === "abort" ? "abort" : "detach",
      });
      if (ending === "cancelled-detach") {
        controller.abort(new Error("Call cancelled"));
      }
      completion.resolve({ text: "Late answer" });
      await settled;
      await expect(runner!({ prompt: "Another task" })).rejects.toThrow("session is closed");
      expect(consult).toHaveBeenCalledOnce();
    },
  );

  it("does not start a cancelled native delegation", async () => {
    const consult = vi.fn(async () => ({ text: "Answer" }));
    const { session, callbacks } = createSession({ runAgentConsult: consult });
    const runner = callbacks.runAgentConsult;
    expect(runner).toBeTypeOf("function");
    await expect(runner!({ prompt: "Old task", signal: AbortSignal.abort() })).rejects.toThrow();
    expect(consult).not.toHaveBeenCalled();
    await session.close();
  });
  it.each(["sink", "provider", "session"] as const)(
    "fences scoped transport acknowledgments after the %s closes",
    (closing) => {
      let open = true;
      const acknowledge = vi.fn();
      const sendMark = vi.fn();
      const acknowledgeMark = vi.fn();
      const { session, callbacks } = createSession(
        { audioSink: { isOpen: () => open, sendAudio: vi.fn(), sendMark } },
        { acknowledgeMark },
      );
      callbacks?.onMark?.("scoped", acknowledge);
      const acknowledgePlayback = sendMark.mock.calls[0]?.[1];
      expect(acknowledgePlayback).toBeTypeOf("function");
      expect(acknowledge).not.toHaveBeenCalled();
      acknowledgePlayback();
      expect(acknowledge).toHaveBeenCalledOnce();
      if (closing === "sink") {
        open = false;
      } else if (closing === "provider") {
        callbacks?.onClose?.("completed");
      } else {
        void session.close();
      }
      acknowledgePlayback();
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(acknowledgeMark).not.toHaveBeenCalled();
    },
  );
  it("routes provider output through an open audio sink", () => {
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const sendMark = vi.fn();
    let open = true;
    const playback = [{ itemId: "audio-1", audioEndMs: 120 }];
    const getPlaybackState = vi.fn(() => playback);

    const { session, callbacks } = createSession({
      cfg: { talk: { realtime: { provider: "test" } } } as never,
      audioSink: {
        isOpen: () => open,
        sendAudio,
        clearAudio,
        sendMark,
        getPlaybackState,
      },
    });

    const metadata = { itemId: "audio-1" };
    callbacks?.onAudio(Buffer.from([1, 2]), metadata);
    callbacks?.onClearAudio("barge-in");
    callbacks?.onMark?.("mark-1");

    expect(callbacks?.cfg).toEqual({ talk: { realtime: { provider: "test" } } });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]), metadata);
    expect(clearAudio).toHaveBeenCalledWith("barge-in");
    expect(sendMark).toHaveBeenCalledWith("mark-1");
    expect(callbacks?.getPlaybackState?.()).toBe(playback);
    open = false;
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    open = true;
    getPlaybackState.mockImplementationOnce(() => {
      void session.close();
      return playback;
    });
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    expect(getPlaybackState).toHaveBeenCalledTimes(2);
  });

  it("passes the requested agent scope and audio format to the provider bridge", () => {
    expectTypeOf<() => Promise<void>>().toExtend<
      NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>
    >();
    const handleDelegationInput = vi.fn(() => "control" as const);
    const onTranscript = vi.fn();
    const { callbacks: request } = createSession({
      handleDelegationInput,
      onTranscript,
      agentId: "voice-agent",
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    });

    expect(request.handleDelegationInput?.("status", vi.fn())).toBe("control");
    expect(handleDelegationInput).toHaveBeenCalledExactlyOnceWith("status", expect.any(Function));
    request.onTranscript?.("user", "status", true);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("user", "status", true);
    const textMode = { textMode: "snapshot" } as const;
    request.onTranscript?.("user", "corrected", false, textMode);
    expect(onTranscript).toHaveBeenLastCalledWith("user", "corrected", false, textMode);
    expect({ agentId: request.agentId, audioFormat: request.audioFormat }).toEqual({
      agentId: "voice-agent",
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    });
  });

  it.each(["ack-immediately", "ignore"] as const)("handles %s provider marks", (markStrategy) => {
    const sendMark = vi.fn();
    const { callbacks, bridge } = createSession({
      audioSink: { sendAudio: vi.fn(), sendMark },
      markStrategy,
    });

    callbacks?.onMark?.("mark-1");

    expect(sendMark).not.toHaveBeenCalled();
    if (markStrategy === "ignore") {
      expect(bridge.acknowledgeMark).not.toHaveBeenCalled();
    } else {
      expect(bridge.acknowledgeMark).toHaveBeenCalledWith("mark-1");
    }
  });

  it("passes tool calls the active session and triggers initial greeting on ready", () => {
    const onToolCall = vi.fn();
    const { session, callbacks, bridge } = createSession({
      initialGreetingInstructions: "Say hello",
      triggerGreetingOnReady: true,
      onToolCall,
    });
    const event = { ...toolCall, args: { q: "test" } };

    callbacks?.onReady?.();
    callbacks?.onToolCall?.(event);

    expect(bridge["triggerGreeting"]).toHaveBeenCalledWith("Say hello");
    expect(onToolCall).toHaveBeenCalledWith(event, session);
  });

  it("routes synchronous and asynchronous tool-call callback failures to onError", async () => {
    const onError = vi.fn();
    const syncFailure = new Error("sync callback failed");
    const onToolCall = vi
      .fn()
      .mockImplementationOnce(() => {
        throw syncFailure;
      })
      .mockImplementationOnce(() => Promise.reject(new Error("async callback failed")));
    const { callbacks } = createSession({ onToolCall, onError });

    callbacks.onToolCall?.(toolCall);
    callbacks.onToolCall?.(toolCall);
    await Promise.resolve();

    expect(onError).toHaveBeenNthCalledWith(1, syncFailure);
    expect(onError).toHaveBeenNthCalledWith(2, new Error("async callback failed"));
  });

  it("contains an onError exception after an asynchronous tool-call failure", async () => {
    const onError = vi.fn(() => {
      throw new Error("error callback failed");
    });
    const { callbacks } = createSession({
      onToolCall: () => Promise.reject(new Error("tool callback failed")),
      onError,
    });

    callbacks.onToolCall?.(toolCall);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(onError).toHaveBeenCalledWith(new Error("tool callback failed"));
  });

  it.each(["session", "provider"])("ignores late tool failures after %s close", async (closing) => {
    const completion = createDeferred();
    const connect = vi.fn(async () => {});
    const onError = vi.fn();
    const { session, callbacks } = createSession(
      { onToolCall: () => completion.promise, onError },
      { connect },
    );
    callbacks.onToolCall?.(toolCall);
    let closeCompletion: ReturnType<typeof session.close> | undefined;
    if (closing === "provider") {
      callbacks.onClose?.("error");
      await expect(session.connect()).rejects.toThrow("Realtime voice connection is closed");
    } else {
      closeCompletion = session.close();
    }
    completion.reject(new Error("late tool callback failure"));
    await closeCompletion;
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    expect(session.bridge.close).toHaveBeenCalledTimes(closing === "session" ? 1 : 0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reopens audio and close reporting for an explicit connection generation", async () => {
    const connect = vi.fn(async () => {});
    const sendProviderAudio = vi.fn();
    const sendSinkAudio = vi.fn();
    const onClose = vi.fn();
    const onReady = vi.fn();
    const { session, callbacks } = createSession(
      {
        audioSink: { sendAudio: sendSinkAudio },
        onClose,
        onReady,
      },
      { connect, sendAudio: sendProviderAudio },
      (request) => request.onClose?.("error"),
    );

    session.sendAudio(Buffer.from("closed-input"));
    callbacks?.onAudio(Buffer.from("closed-output"));
    callbacks?.onClose?.("error");
    callbacks?.onReady?.();
    expect(onReady).not.toHaveBeenCalled();

    await session.connect();
    callbacks?.onReady?.();
    session.sendAudio(Buffer.from("next-input"));
    callbacks?.onAudio(Buffer.from("next-output"));
    callbacks?.onClose?.("completed");
    callbacks?.onClose?.("completed");
    await expect(session.connect()).rejects.toThrow("Realtime voice connection is closed");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(session);
    expect(onClose.mock.calls).toEqual([["error"], ["completed"]]);
    expect(sendProviderAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from("next-input"));
    expect(sendSinkAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from("next-output"), undefined);
  });

  it("forwards tool result continuation options and async acceptance to the provider bridge", () => {
    const acceptance = Promise.resolve();
    const submitToolResult = vi.fn(() => acceptance);
    const { session } = createSession({}, { submitToolResult });

    const result = { status: "working" };
    const options = { willContinue: true };
    const submitted = session.submitToolResult("call-1", result, options);

    expect(submitted).toBe(acceptance);
    expect(submitToolResult).toHaveBeenCalledWith("call-1", result, options);
  });

  it("rejects suppressed results before calling an unsupported provider bridge", () => {
    const submitToolResult = vi.fn();
    const { session } = createSession(
      {},
      {
        submitToolResult,
        supportsToolResultSuppression: false,
      },
    );

    expect(() =>
      session.submitToolResult("call-1", { ok: true }, { suppressResponse: true }),
    ).toThrow("Realtime provider does not support suppressed tool results");
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not expose session callbacks until the provider returns its bridge", () => {
    const onReady = vi.fn();
    const onToolCall = vi.fn();
    const { session, callbacks } = createSession({ onReady, onToolCall }, {}, (request) => {
      request.onReady?.();
      request.onToolCall?.(toolCall);
    });

    expect(onReady).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();

    callbacks?.onReady?.();
    callbacks.onToolCall?.(toolCall);

    expect(onReady).toHaveBeenCalledWith(session);
    expect(onToolCall).toHaveBeenCalledWith(toolCall, session);
  });
});

describe("realtime voice bridge finalization", () => {
  it("drains final transcripts while async close settles with a failure", async () => {
    const completion = createDeferred();
    const close = vi.fn(() => {
      void session.close();
      return completion.promise;
    });
    const onTranscript = vi.fn();
    const onToolCall = vi.fn();
    const sendAudio = vi.fn();
    const { session, callbacks } = createSession(
      {
        audioSink: { sendAudio },
        onTranscript,
        onToolCall,
      },
      { close, handleBargeIn: vi.fn() },
    );

    callbacks?.onTranscript?.("user", "active fragment", false);
    callbacks?.onTranscript?.("assistant", "active final", true);
    expect(onTranscript.mock.calls).toEqual([
      ["user", "active fragment", false],
      ["assistant", "active final", true],
    ]);
    onTranscript.mockClear();

    const closing = session.close();
    expect(closing).toBeInstanceOf(Promise);
    expect(session.close()).toBe(closing);
    session.sendAudio(Buffer.from("late input"));
    session.acknowledgeMark("late mark");
    session.setMediaTimestamp(42);
    session.handleBargeIn();
    void session.submitToolResult("late call", {});
    callbacks?.onAudio(Buffer.from("late output"));
    callbacks?.onToolCall?.({ ...toolCall, itemId: "late item", callId: "late call" });
    callbacks?.onTranscript?.("user", "closing user fragment", false);
    callbacks?.onTranscript?.("assistant", "closing assistant fragment", false);
    expect(onTranscript).not.toHaveBeenCalled();
    callbacks?.onTranscript?.("assistant", "final words", true);
    await expect(session.connect()).rejects.toThrow("Realtime voice session is closed");
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final words", true);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(sendAudio).not.toHaveBeenCalled();
    for (const method of [
      "sendAudio",
      "acknowledgeMark",
      "setMediaTimestamp",
      "handleBargeIn",
      "submitToolResult",
    ] as const) {
      expect(session.bridge[method]).not.toHaveBeenCalled();
    }

    const failure = new Error("cleanup failed");
    completion.reject(failure);
    await expect(closing).rejects.toBe(failure);
    callbacks?.onTranscript?.("assistant", "stale words", true);
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("native delegation session facade", () => {
  it("blocks pre-adoption input before enabling the native hook", async () => {
    const handleDelegationInput = vi.fn(() => "control" as const);
    const respond = vi.fn();
    const { session, callbacks: request } = createSession({ handleDelegationInput }, {}, (next) => {
      expect(next.handleDelegationInput?.("status", respond)).toBe("control");
      expect(handleDelegationInput).not.toHaveBeenCalled();
    });
    try {
      expect(Object.hasOwn(request, "handleDelegationInput")).toBe(true);
      // Buffered native input can arrive after adoption but before any ready event.
      expect(request.handleDelegationInput?.("status", respond)).toBe("control");
      expect(handleDelegationInput).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("fences retained actions and responses after provider close but preserves final transcript flush", () => {
    let reply: ((text: string) => void) | undefined;
    const handleDelegationInput = vi.fn<
      NonNullable<RealtimeVoiceBridgeCallbacks["handleDelegationInput"]>
    >((_text, respond) => {
      reply = respond;
      return "control";
    });
    const onTranscript = vi.fn();
    const { session, callbacks: request } = createSession(
      { handleDelegationInput, onTranscript },
      { close: () => request.onTranscript?.("assistant", "final flush", true) },
    );
    const respond = vi.fn();
    expect(request.handleDelegationInput?.("status", respond)).toBe("control");
    request.onClose?.("completed");
    expect(session.close()).toBeUndefined();
    expect(session.close()).toBeUndefined();
    expect(request.handleDelegationInput?.("late task", respond)).toBe("control");
    reply?.("late result");
    expect(respond).not.toHaveBeenCalled();
    expect(handleDelegationInput).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final flush", true);
  });

  it("contains callback failure without task fallthrough or a second reply", async () => {
    const onError = vi.fn();
    const { session, callbacks: request } = createSession({
      onError,
      handleDelegationInput: (_text, respond) => {
        respond("accepted");
        throw new Error("callback failed");
      },
    });
    const respond = vi.fn();
    try {
      expect(request.handleDelegationInput?.("status", respond)).toBe("control");
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toContain("accepted");
      expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("callback failed"));
    } finally {
      await session.close();
    }
  });
});
