import { StatementSync } from "node:sqlite";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { AdmissionOperations } from "../infra/sqlite-database-admission.worker.test-support.js";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import {
  retainGatewayRootWorkAdmissionContinuationScope,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  type OpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import { readOpenVoiceSessions } from "./client-voice-session-lookup.worker.js";
import { resolveOpenClientVoiceSessionId } from "./client-voice-session-read.js";
import {
  parseStoredVoiceSessionRecord,
  type ClientVoiceSessionRecord,
  type VoiceSessionLookup,
  readOwnedVoiceSessionFacts,
  readVoiceSessionRecordInTransaction,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  completeRun,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

// Install shared mocks before fixture imports load the voice persistence graph.
const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("client voice session", () => {
  const { releaseHeldWrites, sendDurableMessageBatch, sessionTurnMocks } =
    useClientVoiceSessionHarness();
  const appendTurn = sessionTurnMocks.appendExpectedSessionTranscriptTurn;
  const retryBeforeClose = "voice transcript persistence must be retried before close";
  const queueFull = "voice transcript persistence queue capacity exceeded";
  const awaitAppend = (entered: Promise<void>, work: Promise<unknown>) =>
    awaitGateBeforeSettlement(entered, work, "Transcript settled before entering the held append");

  const target = { agentId: "main", sessionKey: "agent:main:main" };
  const createVoiceSession = (
    params: Partial<Parameters<typeof createOrResumeClientVoiceSession>[0]> = {},
  ) => createOrResumeClientVoiceSession({ ...target, origin: "client", ...params });
  async function seededVoice(voiceSessionId: string) {
    await seedSession(target.sessionKey);
    return createVoiceSession({ voiceSessionId });
  }
  const readRecord = (id: string) => clientVoiceSessionTesting.readRecord("main", id);
  const closeVoice = (voiceSessionId: string, now?: number) =>
    closeClientVoiceSession({ ...target, voiceSessionId, config: {}, now });
  const appendTranscript = (
    voiceSessionId: string,
    entryId: string,
    text: string,
    role: "user" | "assistant" = "user",
    sessionKey = target.sessionKey,
  ) =>
    appendClientVoiceTranscript({
      ...target,
      sessionKey,
      sessionTarget: { sessionKey },
      voiceSessionId,
      entryId,
      role,
      text,
    });
  function realTranscriptAppend() {
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    return actualAppend;
  }
  function holdTranscript(failure?: Error) {
    const release = createDeferred();
    const entered = createDeferred();
    releaseHeldWrites.push(() => release.resolve());
    const actualAppend = realTranscriptAppend();
    appendTurn.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      if (failure) {
        throw failure;
      }
      return await actualAppend(...args);
    });
    return { release, entered };
  }

  it("creates, resumes, and enforces ownership and open state", async () => {
    const voiceSessionId = await createVoiceSession({
      provider: "google",
      voiceSessionId: "voice-1",
      now: 10,
    });
    expect(await createVoiceSession({ voiceSessionId, now: 20 })).toBe(voiceSessionId);
    expect(readRecord(voiceSessionId)).toMatchObject({ provider: "google" });
    await expect(createVoiceSession({ provider: "openai", voiceSessionId })).rejects.toThrow(
      "provider does not match",
    );
    await expect(
      createVoiceSession({ sessionKey: "agent:main:other", voiceSessionId }),
    ).rejects.toThrow("does not belong");

    await closeVoice(voiceSessionId, 30);
    await expect(createVoiceSession({ voiceSessionId })).rejects.toThrow("already closed");
  });

  it("preserves declared transcript capability and transport origin", async () => {
    const capable = await createVoiceSession({
      transcriptCapable: true,
      voiceSessionId: "voice-capable",
    });
    const legacy = await createVoiceSession({ voiceSessionId: "voice-legacy" });
    const relay = await createVoiceSession({
      origin: "relay",
      voiceSessionId: "voice-relay",
    });
    expect(readRecord(capable)).toMatchObject({
      transcriptCapable: true,
      origin: "client",
    });
    expect(readRecord(legacy)?.transcriptCapable).not.toBe(true);
    expect(readRecord(relay)?.origin).toBe("relay");
  });

  it("waits for transcript serialization but not mutation digest delivery", async ({ signal }) => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createVoiceSession({ voiceSessionId: "voice-durable-close" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);

    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript();
    const append = appendTranscript(voiceSessionId, "final", "final answer", "assistant");
    await awaitAppend(transcriptEntered.promise, append);

    const digestSend = createDeferred<{ status: "sent" }>();
    const digestEntered = createDeferred();
    releaseHeldWrites.push(() => digestSend.resolve({ status: "sent" }));
    sendDurableMessageBatch.mockImplementationOnce(() => {
      digestEntered.resolve();
      return digestSend.promise;
    });
    let closeSettled = false;
    const close = closeVoice(voiceSessionId, 42).then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(readRecord(voiceSessionId)?.status).toBe("open");

    transcriptWrite.resolve();
    await Promise.all([append, close]);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();
    await withinTest(digestEntered.promise, signal);
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

    digestSend.resolve({ status: "sent" });
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
  });

  it("rejects a concurrent close when an accepted transcript fails", async () => {
    const voiceSessionId = await seededVoice("voice-concurrent-close-failure");
    const failure = new Error("transcript write failed");
    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript(failure);
    const append = appendTranscript(voiceSessionId, "failed", "persist me");
    await awaitAppend(transcriptEntered.promise, append);
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toEqual([expect.any(String)]);
    const close = closeVoice(voiceSessionId, 42);

    transcriptWrite.resolve();
    await expect(append).rejects.toBe(failure);
    await expect(close).rejects.toBe(failure);
    expect(readRecord(voiceSessionId)?.status).toBe("open");
  });

  it("keeps the session open when a failed transcript is retried after close", async () => {
    const voiceSessionId = await seededVoice("voice-close-after-failure");
    const failure = new Error("transcript write failed");
    const { release: transcriptWrite, entered: transcriptEntered } = holdTranscript(failure);
    const append = appendTranscript(voiceSessionId, "retryable", "persist me");
    const appendResult = append.then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitAppend(transcriptEntered.promise, appendResult);
    transcriptWrite.resolve();
    expect(await appendResult).toBe(failure);
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toEqual([expect.any(String)]);
    clientVoiceSessionTesting.reset();
    await expect(closeVoice(voiceSessionId, 42)).rejects.toThrow(retryBeforeClose);
    expect(readRecord(voiceSessionId)?.status).toBe("open");
    appendTurn.mockImplementation(realTranscriptAppend());
    await appendTranscript(voiceSessionId, "retryable", "persist me");
    await closeVoice(voiceSessionId, 99);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 99,
      transcriptFailureKeys: [],
    });
  });

  it("terminally closes relay sessions while retaining unresolved transcript identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = await createVoiceSession({ origin: "relay" });
    appendTurn.mockRejectedValueOnce(new Error("transcript write failed"));

    await expect(
      appendRelayVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "relay-entry-1",
        role: "user",
        text: "persist me",
      }),
    ).rejects.toThrow("transcript write failed");
    const unresolved = readRecord(voiceSessionId)?.transcriptFailureKeys;
    expect(unresolved).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    await closeRelayVoiceSessionRecord({
      ...target,
      voiceSessionId,
      config: {},
    });
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      transcriptFailureKeys: unresolved,
    });
  });

  it("bounds stalled transcript operations and closes after the accepted prefix", async () => {
    const voiceSessionId = await seededVoice("voice-bounded");
    const { release: firstAppend, entered: appendEntered } = holdTranscript();

    const appends = Array.from({ length: 10_000 }, (_, index) =>
      appendTranscript(
        voiceSessionId,
        String(index + 1),
        `  ${"x".repeat(9_000)}  `,
        index % 2 === 0 ? "user" : "assistant",
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    await awaitAppend(appendEntered.promise, Promise.all(appends));
    expect(readRecord(voiceSessionId)?.status).toBe("open");
    firstAppend.resolve();
    const results = await Promise.all(appends);

    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(41);
    expect(rejected).toHaveLength(9_959);
    expect(
      results.every(
        (result) =>
          result.ok || (result.error instanceof Error && result.error.message === queueFull),
      ),
    ).toBe(true);
    expect(appendTurn).toHaveBeenCalledTimes(41);
    expect(appendTurn.mock.calls.map(([, options]) => options.messages[0]?.eventId)).toEqual(
      Array.from({ length: 41 }, (_, index) => `voice:${voiceSessionId}:${index + 1}`),
    );
    const firstMessage = appendTurn.mock.calls[0]?.[1].messages[0]?.message as {
      content?: Array<{ text?: string }>;
    };
    expect(firstMessage.content?.[0]?.text).toHaveLength(8_000);
    await expect(
      appendTranscript(
        voiceSessionId,
        "after-overflow",
        "must remain rejected after the accepted prefix drains",
      ),
    ).rejects.toThrow(queueFull);

    const close = closeVoice(voiceSessionId, 42);
    const duplicateClose = closeVoice(voiceSessionId, 99);
    await Promise.all([close, duplicateClose]);
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
  });

  it("ignores whitespace transcripts without consuming queue capacity", async () => {
    const voiceSessionId = await seededVoice("voice-whitespace");

    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        appendTranscript(voiceSessionId, String(index + 1), " \t\n "),
      ),
    );
    expect(appendTurn).not.toHaveBeenCalled();

    await appendTranscript(voiceSessionId, "real", "persist me");
    expect(appendTurn).toHaveBeenCalledOnce();
    expect(appendTurn.mock.calls[0]?.[1].messages[0]?.eventId).toBe(`voice:${voiceSessionId}:real`);
  });

  it("requires every failed transcript entry to recover before close", async () => {
    const voiceSessionId = await seededVoice("voice-multiple-write-failures");
    appendTurn
      .mockRejectedValueOnce(new Error("first transcript write failed"))
      .mockRejectedValueOnce(new Error("second transcript write failed"));

    for (const entryId of ["1", "2"]) {
      await expect(appendTranscript(voiceSessionId, entryId, entryId)).rejects.toThrow(
        "transcript write failed",
      );
    }
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(2);

    await appendTranscript(voiceSessionId, "later", "later entry", "assistant");
    await appendTranscript(voiceSessionId, "1", "first");
    await expect(closeVoice(voiceSessionId)).rejects.toThrow(retryBeforeClose);

    await appendTranscript(voiceSessionId, "2", "second");
    await closeVoice(voiceSessionId);
    expect(readRecord(voiceSessionId)?.status).toBe("closed");
  });

  it("bounds unresolved transcript failure identity", async () => {
    const voiceSessionId = await seededVoice("voice-write-failure-bound");
    appendTurn.mockRejectedValue(new Error("transcript write failed"));

    for (let index = 0; index < VOICE_TRANSCRIPT_MAX_UNRESOLVED; index += 1) {
      await expect(appendTranscript(voiceSessionId, String(index), "failed entry")).rejects.toThrow(
        "transcript write failed",
      );
    }
    await expect(
      appendTranscript(voiceSessionId, "beyond-bound", "must wait for recovery"),
    ).rejects.toThrow("voice transcript persistence has too many unresolved entries");
    expect(appendTurn).toHaveBeenCalledTimes(VOICE_TRANSCRIPT_MAX_UNRESOLVED);
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );

    appendTurn.mockImplementation(realTranscriptAppend());
    await appendTranscript(voiceSessionId, "0", "recovered entry");
    appendTurn.mockRejectedValueOnce(new Error("replacement transcript write failed"));
    await expect(
      appendTranscript(voiceSessionId, "replacement", "replacement entry"),
    ).rejects.toThrow("replacement transcript write failed");
    expect(readRecord(voiceSessionId)?.transcriptFailureKeys).toHaveLength(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );
  });

  it("keeps durable operation ownership independent between voice sessions", async () => {
    await seedSession("agent:main:first");
    await seedSession("agent:main:second");
    const firstVoiceSessionId = await createVoiceSession({
      sessionKey: "agent:main:first",
      voiceSessionId: "voice-first",
    });
    const secondVoiceSessionId = await createVoiceSession({
      sessionKey: "agent:main:second",
      voiceSessionId: "voice-second",
    });
    const { release: firstAppend, entered: appendEntered } = holdTranscript();

    const first = appendTranscript(firstVoiceSessionId, "1", "first", "user", "agent:main:first");
    await awaitAppend(appendEntered.promise, first);
    const second = appendTranscript(
      secondVoiceSessionId,
      "1",
      "second",
      "user",
      "agent:main:second",
    );

    await second;
    expect(appendTurn).toHaveBeenCalledTimes(2);
    firstAppend.resolve();
    await first;
  });

  it("resolves the open client record for legacy tool calls", async () => {
    const voiceSessionId = await createVoiceSession();

    const closed = await createVoiceSession({ voiceSessionId: "discarded-closed" });
    await closeVoice(closed);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(
        await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
      ).toBe(voiceSessionId);
      expect(
        observation.queries.filter((query) => /select.*value_json.*cache_entries/is.test(query)),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(
      await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:other" }),
    ).toBeUndefined();
    await createVoiceSession();
    expect(
      await resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
    ).toBeUndefined();
  });

  it("records only mutating started effects and updates their terminal status", async () => {
    const voiceSessionId = await createVoiceSession();
    await registerClientVoiceConsultRun({
      ...target,
      voiceSessionId,
      runId: "run-1",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "read-1",
      toolName: "read",
      mutatingAction: false,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      durationMs: 4,
      errorCategory: "aborted",
      terminalReason: "cancelled",
    });

    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(readRecord(voiceSessionId)?.effects).toEqual([
      expect.objectContaining({
        toolCallId: "message-1",
        toolName: "message",
        status: "cancelled",
        finishedAt: expect.any(Number),
      }),
    ]);
  });

  describe("run lifecycle", () => {
    async function open(name: string, agentId = "main") {
      const binding = { agentId, sessionKey: `agent:${agentId}:${name}` };
      return {
        ...binding,
        voiceSessionId: await createOrResumeClientVoiceSession({
          ...binding,
          origin: "client",
          voiceSessionId: `voice-${name}`,
        }),
      };
    }
    const registerRun = registerClientVoiceConsultRun;

    afterEach(() => {
      clientVoiceSessionTesting.reset();
      resetGatewayWorkAdmission();
    });
    it.each(["before", "after"])(
      "keeps completion ownership when a run registers %s transport close",
      async (when) => {
        const session = await open("active");
        const register = () => registerRun({ ...session, runId: "run-active" });
        if (when === "before") {
          await register();
        }
        await closeClientVoiceSession({ ...session, config: {} });
        if (when === "after") {
          await register();
        }
        expect(resolveClientVoiceRunBinding("run-active")).toMatchObject({
          voiceSessionId: session.voiceSessionId,
        });
        await completeRun("run-active");
        expect(resolveClientVoiceRunBinding("run-active")).toBeUndefined();
      },
    );

    it("keeps shared-state close pending after a live consult loses read admission", async () => {
      const database = openOpenClawStateDatabase();
      const context = captureOpenClawStateWorkerContext();
      const sessionKey = "agent:main:state-close";
      const runId = "state-close-consult";
      const voiceSessionId = await createVoiceSession({ sessionKey });
      const voiceClose = prepareClientVoiceSessionClose();
      const root = tryBeginGatewayRootWorkAdmission()!;
      await root.run(() => registerRun({ agentId: "main", voiceSessionId, sessionKey, runId }));
      let voiceDrained = false;
      let stateClosed = false;
      const voiceDrain = voiceClose.drain().then(() => {
        voiceDrained = true;
      });
      const stateClose = closeOpenClawStateDatabaseAsync().then(() => {
        stateClosed = true;
      });
      try {
        expect(() => context.admission.assertCurrent()).toThrow();
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          runId,
          toolCallId: "after-state-fence",
          toolName: "message",
          mutatingAction: true,
        });
        await nextEventLoopTurn();
        expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
        expect({ voiceDrained, stateClosed, databaseOpen: database.db.isOpen }).toEqual({
          voiceDrained: false,
          stateClosed: false,
          databaseOpen: true,
        });
        root.release();
        await Promise.all([voiceDrain, stateClose]);
        expect(database.db.isOpen).toBe(false);
        expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
      } finally {
        root.release();
        await Promise.all([voiceDrain, stateClose]);
      }
    });

    it.each(["before launch", "after ACK", "runtime reset"] as const)(
      "releases an accepted run after failure %s",
      async (failure) => {
        const sessionKey = "agent:main:failed-consult";
        const runId = "failed-consult";
        const voiceSessionId = await createVoiceSession({ sessionKey });
        const close = prepareClientVoiceSessionClose();
        const root = tryBeginGatewayRootWorkAdmission()!;
        const retained = await root.run(async () => {
          await registerRun({ agentId: "main", voiceSessionId, sessionKey, runId });
          return failure === "after ACK" ? retainGatewayRootWorkAdmissionContinuationScope() : null;
        });
        try {
          // A diagnostic can precede deferred work; it cannot retire accepted ownership.
          await completeRun(runId);
          expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
          close.beginClose();
          if (failure === "runtime reset") {
            resetGatewayWorkAdmission();
          } else {
            const error = new Error("synthetic consult failure");
            if (retained) {
              root.release();
              expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
            }
            const scope = retained ?? root;
            await expect(
              scope
                .run(async () => {
                  throw error;
                })
                .finally(scope.release),
            ).rejects.toBe(error);
          }
          expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
          await close.drain();
        } finally {
          root.release();
          retained?.release();
          await close.drain();
        }
      },
    );

    it("releases only the prior scope when a run binding is replaced", async () => {
      const first = await open("first", "agent-a");
      const firstRoot = tryBeginGatewayRootWorkAdmission()!;
      const releaseFirst = await firstRoot.run(() =>
        registerClientVoiceConsultRun({ ...first, runId: "run-shared" }),
      );
      await closeClientVoiceSession({ ...first, config: {} });
      const unrelated = await open("unrelated", "agent-b");
      await registerClientVoiceConsultRun({ ...unrelated, runId: "run-unrelated" });
      const replacement = await open("replacement", "agent-b");
      const replacementRoot = tryBeginGatewayRootWorkAdmission()!;
      await replacementRoot.run(() =>
        registerClientVoiceConsultRun({ ...replacement, runId: "run-shared" }),
      );

      releaseFirst();
      expect(resolveClientVoiceRunBinding("run-shared")).toMatchObject({
        voiceSessionId: replacement.voiceSessionId,
      });
      expect(resolveClientVoiceRunBinding("run-unrelated")).toMatchObject({
        voiceSessionId: unrelated.voiceSessionId,
      });

      const close = prepareClientVoiceSessionClose();
      close.beginClose();
      replacementRoot.release();
      // Reassignment released the old permit even while its original root survives.
      await close.drain();
      firstRoot.release();
      expect(resolveClientVoiceRunBinding("run-shared")).toBeUndefined();

      await completeRun("run-unrelated");
    });
  });

  describe("persisted records", () => {
    const options = { agentId: "main" };
    const scope = "talk-client-voice-sessions";
    const binding = { agentId: "main", voiceSessionId: "voice-1", sessionKey: "agent:main:main" };
    const original: ClientVoiceSessionRecord = {
      ...binding,
      version: 1,
      origin: "client",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      consultRunIds: [],
      effects: [],
      transcriptFailureKeys: [],
    };
    const parseRecord = (transcriptFailureKeys: unknown, patch?: Record<string, unknown>) =>
      parseStoredVoiceSessionRecord(
        JSON.stringify({ ...original, transcriptFailureKeys, ...patch }),
      );
    const lookup = (input: VoiceSessionLookup) => readOpenVoiceSessions(options, input).matches;
    const write = (patch: Partial<ClientVoiceSessionRecord>) =>
      runOpenClawAgentWriteTransaction(
        (owner) => writeVoiceSessionRecordInTransaction(owner, { ...original, ...patch }),
        options,
      );

    let database: OpenClawAgentDatabase;
    beforeEach(() => {
      database = openOpenClawAgentDatabase(options);
    });

    it("preserves cache custody columns across rejected updates and a successful retry", async () => {
      write({ updatedAt: 1 });
      database.db
        .prepare("UPDATE cache_entries SET blob = ?, expires_at = ? WHERE scope = ? AND key = ?")
        .run(Buffer.from([0, 255, 4]), 123, scope, original.voiceSessionId);
      const read = () =>
        database.db
          .prepare(
            "SELECT value_json, hex(blob) AS blob, expires_at FROM cache_entries WHERE scope = ? AND key = ?",
          )
          .get(scope, original.voiceSessionId);
      const before = read();
      database.db.exec(`CREATE TEMP TRIGGER reject_voice_update BEFORE UPDATE ON main.cache_entries
        WHEN NEW.scope = 'talk-client-voice-sessions' AND NEW.updated_at = 2
        BEGIN SELECT RAISE(ABORT, 'synthetic voice update failure'); END`);
      expect(() => write({ updatedAt: 2 })).toThrow("synthetic voice update failure");
      expect(database.db.isTransaction).toBe(false);
      expect(read()).toEqual(before);
      database.db.exec("DROP TRIGGER reject_voice_update");
      write({ updatedAt: 3 });
      expect(read()).toEqual({
        value_json: JSON.stringify({ ...original, updatedAt: 3 }),
        blob: "00FF04",
        expires_at: 123,
      });
      const saved = readVoiceSessionRecordInTransaction(database, original.voiceSessionId);
      expect(saved).toEqual({ ...original, updatedAt: 3 });
    });

    it("filters open lookup candidates in SQL before decoding payloads", async () => {
      const rows = [];
      for (const patch of [
        { voiceSessionId: "selected" },
        { voiceSessionId: "closed", status: "closed" },
        { voiceSessionId: "other", sessionKey: "agent:main:other" },
        { voiceSessionId: "relay", origin: "relay" },
        { voiceSessionId: "foreign", agentId: "other" },
        { voiceSessionId: "recent", sessionKey: "agent:main:recent", updatedAt: 10 },
        { voiceSessionId: "excluded", sessionKey: "agent:main:excluded" },
        { voiceSessionId: "invalid", version: 2 },
      ]) {
        rows.push({ ...original, ...patch });
      }
      const insert = database.db.prepare(
        "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const row of rows) {
        insert.run(scope, row.voiceSessionId, JSON.stringify(row), row.updatedAt);
      }
      insert.run(scope, "malformed", "{broken", 1);
      insert.run("unrelated-cache", "other", "not JSON", 1);
      const parse = vi.spyOn(JSON, "parse");
      try {
        const legacy = lookup({ kind: "legacy", ...options, sessionKey: binding.sessionKey });
        expect(legacy).toEqual([{ voiceSessionId: "selected", sessionKey: binding.sessionKey }]);
        const decoded = () =>
          parse.mock.calls
            .map(([value]) => value)
            .filter((value) => value.includes('"voiceSessionId"'));
        const expected = [rows[0], rows[7]].map((row) => JSON.stringify(row));
        expect(decoded().toSorted()).toEqual(expected.toSorted());
        parse.mockClear();
        const stale = lookup({
          kind: "stale",
          ...options,
          updatedBefore: 1,
          excludeVoiceSessionId: "excluded",
        }).map((row) => row.voiceSessionId);
        expect(stale.toSorted()).toEqual(["foreign", "other", "relay", "selected"]);
        expect(decoded()).toHaveLength(5);
        for (const row of [rows[1], rows[5], rows[6]]) {
          expect(decoded()).not.toContain(JSON.stringify(row));
        }
      } finally {
        parse.mockRestore();
      }
    });

    it("refreshes tool facts after local writes, rollback, and worker commits without freshness probes", async () => {
      write({});
      const probes = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["freshness"],
        (sql) => (/data_version/iu.test(sql) ? "freshness" : null),
      );
      expect(readOwnedVoiceSessionFacts(binding)).toMatchObject({ status: "open" });
      expect(() =>
        runOpenClawAgentWriteTransaction((owner) => {
          writeVoiceSessionRecordInTransaction(owner, { ...original, status: "closed" });
          throw new Error("synthetic rollback");
        }, options),
      ).toThrow("synthetic rollback");
      expect(readOwnedVoiceSessionFacts(binding)).toMatchObject({ status: "open" });
      write({ transcriptCapable: true });
      expect(readOwnedVoiceSessionFacts(binding)).toMatchObject({ transcriptCapable: true });
      const broker = new SqliteWorkerBroker();
      try {
        const store = await broker.open<AdmissionOperations>({
          moduleUrl: new URL(
            "../infra/sqlite-database-admission.worker.test-support.ts",
            import.meta.url,
          ),
          databasePath: database.path,
          input: undefined,
        });
        await broker.runOperation(store!, (worker) =>
          worker.execute({
            type: "writeRows",
            input: {
              sql: `UPDATE cache_entries
            SET value_json = json_set(value_json, '$.status', 'closed', '$.hasUserTranscript', json('true'))
            WHERE scope = 'talk-client-voice-sessions' AND key = 'voice-1'`,
            },
          }),
        );
      } finally {
        await broker.close();
      }
      const facts = readOwnedVoiceSessionFacts(binding);
      expect(facts).toMatchObject({ status: "closed", hasUserTranscript: true });
      expect(probes.counts).toEqual({ freshness: 0 });
      probes.restore();
    });

    it("defaults unresolved transcript failures for existing records", () => {
      expect(parseRecord(undefined)?.transcriptFailureKeys).toEqual([]);
    });

    it("rejects malformed, duplicate, or over-cap unresolved transcript failures", () => {
      const key = "a".repeat(64);
      expect(parseRecord(["not-a-hash"])).toBeUndefined();
      expect(parseRecord([key, key])).toBeUndefined();
      const tooMany = Array.from({ length: VOICE_TRANSCRIPT_MAX_UNRESOLVED + 1 }, (_, index) =>
        index.toString(16).padStart(64, "0"),
      );
      expect(parseRecord(tooMany)).toBeUndefined();
    });

    it("rejects an invalid provider", () => {
      expect(parseRecord([], { provider: "   " })).toBeUndefined();
    });
  });
});
