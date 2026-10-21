// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { AcpSessionReadInput } from "../acp/runtime/session-meta-read.types.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withDisposableOpenClawStateReads,
} from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadSource,
  retireIdleOpenClawStateReadWorkers,
} from "./openclaw-state-read-worker.js";
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

it.each(["complete", "cancel", "revoke", "consumer-error", "worker-failure"] as const)(
  "joins asynchronous stream consumption before releasing its reader (%s)",
  async (finish) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const controller = new AbortController();
    const taskController = new AbortController();
    const failure = new Error(`stream ${finish}`);
    let current = true;
    const authority = {
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
        if (!current) {
          throw failure;
        }
        context.admission.assertCurrent();
      },
    };
    const consumed = createDeferredCore();
    let chunkSignal: AbortSignal | undefined;
    const onChunkAsync = vi.fn(async (value: unknown, signal: AbortSignal) => {
      expect(value).toEqual(["bounded row"]);
      expect(signal.aborted).toBe(false);
      chunkSignal = signal;
      if (finish === "worker-failure") {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      await consumed.promise;
    });
    const task = createDeferredCore<OpenClawStateReadReply>();
    mock.runTask.mockReturnValueOnce({ result: task.promise, close: async () => {} });
    const transport = captureOpenClawStateReadSource().createTransport(
      { type: "backup.runs" },
      undefined,
      onChunkAsync,
    );
    const reading = transport.startRead(
      { context, location: options.path, checkFreshAdmission: false },
      authority,
    );
    const request = mock.runTask.mock.calls[0]?.[1].onRequest;
    if (!request) {
      throw new Error("Stream reader did not admit asynchronous consumption");
    }
    const response = request(["bounded row"], {
      signal: taskController.signal,
      yieldSignal: new AbortController().signal,
    });
    const responseAssertion =
      finish === "complete"
        ? expect(response).resolves.toMatchObject({ input: null })
        : finish === "worker-failure"
          ? expect(response).rejects.toMatchObject({ name: "AbortError" })
          : expect(response).rejects.toBe(failure);
    try {
      expect(onChunkAsync).toHaveBeenCalledOnce();
      if (finish === "cancel") {
        controller.abort(failure);
      } else if (finish === "revoke") {
        current = false;
      } else if (finish === "worker-failure") {
        taskController.abort();
        task.reject(failure);
        expect(chunkSignal?.aborted).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
      }
      const closing = transport.startClose();
      const settled = vi.fn();
      void closing.then(settled, settled);
      // Let native close settle; an accepted consumer still owns its pending callback.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).not.toHaveBeenCalled();
      if (finish === "consumer-error") {
        consumed.reject(failure);
      } else {
        consumed.resolve();
      }
      await responseAssertion;
      await closing;
      if (finish === "worker-failure") {
        await expect(reading).resolves.toEqual({ error: failure });
        expect(controller.signal.aborted).toBe(false);
      }
      expect(onChunkAsync).toHaveBeenCalledOnce();
      expect(mock.runTask).toHaveBeenCalledOnce();
    } finally {
      controller.abort(failure);
      consumed.resolve();
      task.resolve(emptyReply);
      await Promise.allSettled([responseAssertion, reading, transport.startClose()]);
    }
  },
);

it.each([true, false])(
  "inherits work-scope cancellation only for inspection reads (%s)",
  async (inspection) => {
    const { pathname, options } = source();
    const scope = new AsyncWorkScope();
    const task = queueTask();
    const failure = new Error("inspection deadline reached");
    const read = () =>
      scope.run(() => executeExistingOpenClawStateRead(options, { type: "backup.runs" }));
    const reading = withExistingOpenClawStateSchema({ path: pathname }, () =>
      inspection
        ? withDisposableOpenClawStateReads(pathname, () => withArtifactPreservingStateReads(read))
        : read(),
    );
    const outcome = inspection
      ? expect(reading).rejects.toBe(failure)
      : expect(reading).resolves.toEqual(emptyReply);
    try {
      await task.captured;
      scope.beginClose(failure);
      if (!inspection) {
        expect(task.close).not.toHaveBeenCalled();
        task.result.resolve(emptyReply);
      }
      await outcome;
      expect(task.close).toHaveBeenCalledOnce();
    } finally {
      task.result.reject(failure);
      await Promise.allSettled([reading, outcome]);
    }
  },
);

it("captures queued read routing and schema facts without reading unrelated environment values", async () => {
  const { root, pathname } = source();
  let unrelatedReads = 0;
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SUPERVISOR_MODE: " EXTERNAL ",
    get UNRELATED_INITIALIZATION_VALUE() {
      unrelatedReads += 1;
      return "synthetic initializer input";
    },
  };
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = withExistingOpenClawStateSchema({ path: pathname }, () =>
    executeExistingOpenClawStateRead({ path: pathname, env }, { type: "backup.runs" }),
  );
  try {
    expect((await task.submitted).diagnosticOperation).toBe("backup.runs");
    env.OPENCLAW_STATE_DIR = path.join(root, "changed-after-capture");
    env.OPENCLAW_SUPERVISOR_MODE = "internal";
    dispatch.resolve();
    const request = await task.captured;
    expect(request.context.environment).toEqual({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_SUPERVISOR_MODE: "external",
    });
    expect(request.context.existingSchemaPath).toBe(pathname);
    // Windows captures case-insensitive environment semantics before selecting these facts.
    if (process.platform !== "win32") {
      expect(unrelatedReads).toBe(0);
    }
    task.result.resolve(emptyReply);
    await expect(result).resolves.toEqual(emptyReply);
  } finally {
    dispatch.resolve();
    task.result.resolve(emptyReply);
    await Promise.allSettled([result]);
  }
});

it("lets an active reader's host callback finish a nested read before the parent settles", async () => {
  const { pathname, options } = source();
  if (threadId === 0) {
    // Native hosts publish real admission; raw Worker hosts intentionally retain native checks.
    fs.unlinkSync(pathname);
    openOpenClawStateDatabase(options);
  }
  const context = captureOpenClawStateWorkerContext(options);
  const location = { context, location: pathname, checkFreshAdmission: false };
  const controller = new AbortController();
  const authority = { signal: controller.signal, assertCurrent: context.admission.assertCurrent };
  const firstTask = queueTask();
  const nestedTask = queueTask();
  const nestedTransport = captureOpenClawStateReadSource().createTransport({ type: "backup.runs" });
  let nested: Promise<unknown> | undefined;
  const transport = captureOpenClawStateReadSource().createTransport(
    { type: "backup.runs" },
    () => {
      nested = nestedTransport.startRead(location, authority);
    },
  );
  const parent = transport.startRead(location, authority);
  try {
    const submitted = await firstTask.submitted;
    await firstTask.captured;
    if (!submitted.onRequestSync) {
      throw new Error("Reader callback was not installed");
    }
    submitted.onRequestSync("synthetic chunk", {
      signal: controller.signal,
      yieldSignal: controller.signal,
    });
    await nestedTask.captured;
    nestedTask.result.resolve(emptyReply);
    await expect(nested).resolves.toEqual({ value: emptyReply });
    firstTask.result.resolve(emptyReply);
    await expect(parent).resolves.toEqual({ value: emptyReply });
  } finally {
    firstTask.result.resolve(emptyReply);
    nestedTask.result.resolve(emptyReply);
    await Promise.allSettled([parent, nested]);
    await Promise.all([transport.startClose(), nestedTransport.startClose()]);
  }
});

it("retains the shared pool after a resource drain fails until canonical retry", async () => {
  const { options, read } = readFixture();
  readyTask();
  await read();
  const failure = new Error("accepted resource cleanup failed");
  const close = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue();
  const unregister = registerOpenClawStateDatabaseAsyncResource({ close });
  try {
    await expect(closeOpenClawStateDatabaseAsync()).rejects.toBe(failure);
    expect(mock.closePool).not.toHaveBeenCalled();
    // The retained pool stays live, so reads resume until the retry seals again.
    captureOpenClawStateWorkerContext(options);
    await closeOpenClawStateDatabaseAsync();
    expect(close).toHaveBeenCalledTimes(2);
    expect(mock.closePool).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[1]).toBeLessThan(
      mock.closePool.mock.invocationCallOrder[0]!,
    );
  } finally {
    unregister();
  }
});

it("preserves task and cleanup errors across explicit retirement retries", async () => {
  const { pathname, read } = readFixture();
  const task = queueTask();
  const original = new Error("original worker task failed");
  const retirement = new Error("first worker stop failed");
  const retryFailure = new Error("second worker stop failed");
  task.close.mockRejectedValueOnce(retirement);
  task.close.mockRejectedValueOnce(retryFailure);
  const result = read();
  const assertion = expect(result).rejects.toMatchObject({
    cause: original,
    errors: [original, retirement],
  });
  await task.captured;
  task.result.reject(original);
  await assertion;
  expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(mock.closePool).not.toHaveBeenCalled();

  // Result and native settlement are separate: the initial close reports the
  // cached first stop failure; only a later lifecycle close retries that stop.
  await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
  expect(task.close).toHaveBeenCalledTimes(2);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.runTask).toHaveBeenCalledOnce();
  await expect(result).rejects.toMatchObject({ cause: original, errors: [original, retirement] });
});

it("reads externally created state after an absent read without allocating a worker first", async () => {
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "backup.runs" } as const;
  expect(await executeExistingOpenClawStateRead(options, command)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.runTask).not.toHaveBeenCalled();
  expect(mock.selectSqlite).not.toHaveBeenCalled();

  fs.writeFileSync(pathname, "mock worker source");
  const task = queueTask();
  task.result.resolve(emptyReply);
  expect(await executeExistingOpenClawStateRead(options, command)).toEqual(emptyReply);
  expect(mock.selectSqlite).toHaveBeenCalledOnce();
  expect(task.close).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mock.closePool).not.toHaveBeenCalled();
});

it("retires a successful read without hydrating an error and retains custody until exit", async () => {
  const { read } = readFixture();
  const hydrate = vi.spyOn(
    await import("./openclaw-state-worker-error.js"),
    "hydrateOpenClawStateWorkerError",
  );
  const task = queueTask();
  const stopping = createDeferredCore();
  const stopped = createDeferredCore();
  task.close.mockImplementationOnce(() => {
    stopping.resolve();
    return stopped.promise;
  });
  const reply: OpenClawStateReadReply = {
    ...emptyReply,
    nativeCleanupFailure: { error: undefined },
  };
  const result = read();
  const assertion = expect(result).resolves.toMatchObject({
    ok: true,
    type: "backup.runs",
    runs: [],
  });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void result.then(markSettled, markSettled);
  try {
    await task.captured;
    task.result.resolve(reply);
    await stopping.promise;
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.selectSqlite).toHaveBeenCalledOnce();
    expect(mock.selectSqlite.mock.invocationCallOrder[0]).toBeLessThan(
      mock.create.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    task.result.resolve(reply);
    stopped.resolve();
    try {
      await assertion;
    } finally {
      hydrate.mockRestore();
    }
  }
  expect(task.close).toHaveBeenCalledOnce();
});

it("preserves source and worker stop failures when native cleanup fails", async () => {
  const { pathname, read } = readFixture();
  const task = queueTask();
  const primary = new Error("source query failed");
  const stop = new Error("worker native exit not confirmed");
  task.close.mockRejectedValueOnce(stop);
  const result = read();
  const outcome = result.catch((error: unknown) => error);
  await task.captured;
  task.result.resolve({
    ok: false,
    sourceAdmitted: true,
    message: primary.message,
    error: encodeOpenClawStateWorkerError(primary, { includeOrdinary: true }),
    nativeCleanupFailure: { error: undefined },
  });
  const failure = await outcome;
  assert(failure instanceof AggregateError, "Read cleanup did not retain its error graph");
  expect(failure.cause).toBe(failure.errors[0]);
  expect(failure.errors).toHaveLength(2);
  expect(failure.cause).toMatchObject({ message: primary.message });
  expect(failure.errors[1]).toBe(stop);
  expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(mock.closePool).not.toHaveBeenCalled();

  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(2);
  await expect(result).rejects.toBe(failure);
});

it("closes one read path without aborting its sibling", async () => {
  const firstSource = readFixture("first.sqlite");
  const siblingSource = readFixture("sibling.sqlite");
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = firstSource.read();
  const assertion = expect(firstRead).rejects.toThrow(/read admission (?:is )?closed/i);
  const siblingRead = siblingSource.read();
  await Promise.all([first.captured, sibling.captured]);
  const firstOptions = await first.submitted;
  const siblingOptions = await sibling.submitted;
  await closeOpenClawStateDatabaseByPathAsync(firstSource.pathname);
  await assertion;
  expect(firstOptions.signal?.aborted).toBe(true);
  expect(first.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(siblingOptions.signal?.aborted).toBe(false);
  expect(sibling.close).not.toHaveBeenCalled();
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalledOnce();
  sibling.result.resolve(emptyReply);
  expect(await siblingRead).toEqual(emptyReply);
  expect(sibling.close).toHaveBeenCalledExactlyOnceWith(undefined);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

// Capture and byte accounting are structural; the batch case below adds arrays and preparation.
it("captures scalar selectors and byte charges before queued dispatch", async () => {
  const { options } = source();
  const selector = "租户🦞".repeat(512);
  const input = { reason: selector, includeRunId: selector, active: true, limit: 100 };
  const command = { type: "updateRuns.list", input } as const;
  const expected = structuredClone(command);
  const originalRoot = options.env.OPENCLAW_STATE_DIR;
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const task = queueTask(dispatch.promise);
  const baseline = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const result = executeExistingOpenClawStateRead(options, command);
  try {
    const [baselineOptions, submitted] = await Promise.all([
      baselineTask.submitted,
      Promise.race([
        task.submitted,
        result.then(() => {
          throw new Error("Read settled before queued dispatch");
        }),
      ]),
    ]);
    Object.assign(input, { reason: "changed", includeRunId: "changed", active: false, limit: 1 });
    options.env.OPENCLAW_STATE_DIR = path.join(originalRoot, "different");
    expect(Number.isSafeInteger(submitted.inputBytes)).toBe(true);
    expect(submitted.inputBytes).toBeGreaterThanOrEqual(
      Number(baselineOptions.inputBytes) +
        Buffer.byteLength(expected.type) -
        Buffer.byteLength("backup.runs") +
        Buffer.byteLength(selector) * 2 +
        9,
    );
    dispatch.resolve();
    await baselineTask.captured;
    baselineTask.result.resolve(emptyReply);
    const request = await task.captured;
    expect(request.command).toEqual(expected);
    expect(request.context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
    const reply: OpenClawStateReadReply = {
      ok: true,
      type: "updateRuns.list",
      sourceAdmitted: true,
      runs: [],
    };
    task.result.resolve(reply);
    expect(await result).toEqual(reply);
    await baseline;
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    task.result.resolve(emptyReply);
    await Promise.allSettled([baseline, result]);
  }
});

it("captures and charges nested batches before preparation and queued dispatch", async () => {
  const type = "acpSessions.metadata";
  const { options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const keys = ["principal-根🦞", "second-principal"];
  const entry = {
    lifecycleRevision: "revision-根🦞",
    sessionId: "session-根🦞",
    sessionStartedAt: 0,
  };
  const metadata = { keys, entry };
  const entries: AcpSessionReadInput[] = [metadata, { keys: ["entry-without-optionals"] }];
  const expectedEntries: AcpSessionReadInput[] = [
    { ...metadata, keys: [...keys], entry: { ...entry } },
    { keys: ["entry-without-optionals"] },
  ];
  const payloadBytes =
    Buffer.byteLength(
      [...keys, entry.lifecycleRevision, entry.sessionId, "entry-without-optionals"].join(""),
    ) + 8;
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const task = queueTask(dispatch.promise);
  const baseline = captureOpenClawStateReadSource().createTransport({ type: "backup.runs" });
  const transport = captureOpenClawStateReadSource().createTransport({ type, entries });
  keys[0] = "changed-before-preparation";
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent: context.admission.assertCurrent,
  };
  const location = { context, location: options.path, checkFreshAdmission: true };
  const baselineRead = baseline.startRead(location, authority);
  const read = transport.startRead(location, authority);
  try {
    const [baselineOptions, batchOptions] = await Promise.all([
      baselineTask.submitted,
      task.submitted,
    ]);
    const additionalBytes =
      Buffer.byteLength(type) - Buffer.byteLength("backup.runs") + payloadBytes;
    expect(batchOptions.inputBytes).toBeGreaterThanOrEqual(
      Number(baselineOptions.inputBytes) + additionalBytes,
    );
    keys[0] = "changed-principal";
    keys.push("added-after-admission");
    entry.lifecycleRevision = "changed-revision";
    entry.sessionId = "changed-session";
    entry.sessionStartedAt = 99;
    entries.push({ keys: ["added-entry-after-admission"] });
    dispatch.resolve();
    await baselineTask.captured;
    baselineTask.result.resolve(emptyReply);
    expect((await task.captured).command).toEqual({ type, entries: expectedEntries });
    task.result.resolve({
      ok: true,
      type,
      sourceAdmitted: true,
      rows: expectedEntries.map(() => null),
    });
    await Promise.all([baselineRead, read]);
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    task.result.resolve(emptyReply);
    await Promise.allSettled([baselineRead, read]);
    await Promise.all([baseline.startClose(), transport.startClose()]);
  }
});

const backupRead = { type: "backup.runs" } as const;
function readyTask() {
  const task = queueTask();
  task.result.resolve(emptyReply);
  return task;
}

function withReadGeneration(
  workerUrl: URL,
  operation: (source: ReturnType<typeof captureOpenClawStateReadSource>) => Promise<void>,
) {
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("stateRead");
  return withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => (url.href === moduleUrl.href ? workerUrl : url));
      await operation(captureOpenClawStateReadSource());
    },
    async () => {},
  );
}

function readFixture(name?: string) {
  const fixture = source(name);
  const { options, pathname } = fixture;
  return {
    ...fixture,
    read: () => executeExistingOpenClawStateRead(options, backupRead),
    get location() {
      return {
        context: captureOpenClawStateWorkerContext(options),
        location: pathname,
        checkFreshAdmission: false,
      };
    },
    authority: { signal: new AbortController().signal, assertCurrent: () => {} },
  };
}

it("retires cached readers after independent custody joins and permits reuse", async () => {
  const { read } = readFixture();
  const nativeSource = captureRetainedNativeWorkerSource();
  const task = queueTask();
  const reading = read();
  try {
    await task.captured;
    expect(await retireIdleOpenClawStateReadWorkers(nativeSource)).toBe(false);
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    task.result.resolve(emptyReply);
    await reading;
  }
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(await retireIdleOpenClawStateReadWorkers(nativeSource)).toBe(true);
  expect(mock.closePool).toHaveBeenCalledOnce();

  readyTask();
  await expect(read()).resolves.toEqual(emptyReply);
  expect(mock.create).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "refuses writer-held reader retirement before cleanup (targeted close: %s)",
  async (explicitSqliteCloseReleasesNativeResources) => {
    const { options, read } = readFixture();
    mock.capabilities.mockReturnValue({
      explicitSqliteCloseReleasesNativeResources,
      decided: true,
      reason: "test policy",
    });
    const nativeSource = captureRetainedNativeWorkerSource();
    readyTask();
    await read();

    await expect(
      runOpenClawAgentWriteAdmission({ agentId: "main", path: options.path }, () =>
        retireIdleOpenClawStateReadWorkers(nativeSource),
      ),
    ).rejects.toThrow("while holding a store writer");
    expect(mock.closeResources).not.toHaveBeenCalled();
    expect(mock.rotate).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();

    await expect(retireIdleOpenClawStateReadWorkers(nativeSource)).resolves.toBe(true);
    expect(
      explicitSqliteCloseReleasesNativeResources ? mock.closeResources : mock.rotate,
    ).toHaveBeenCalledOnce();
    expect(mock.closePool).toHaveBeenCalledOnce();
  },
);

it("keeps lazy reads with their captured generation when another generation dispatches them", async () => {
  const { location, authority } = readFixture();
  const firstUrl = new URL("file:///synthetic/first/state-reader.mjs");
  const secondUrl = new URL("file:///synthetic/second/state-reader.mjs");
  await withReadGeneration(firstUrl, async (first) => {
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.selectSqlite).not.toHaveBeenCalled();
    await withReadGeneration(secondUrl, async (second) => {
      const transports = [first, second].map((reader) => {
        readyTask();
        return reader.createTransport(backupRead);
      });
      try {
        for (const transport of transports) {
          await expect(transport.startRead(location, authority)).resolves.toEqual({
            value: emptyReply,
          });
        }
        expect(mock.create.mock.calls).toMatchObject(
          [firstUrl, secondUrl].map((workerUrl) => [{ workerUrl }, { retainedTransport: true }]),
        );
      } finally {
        await Promise.all(transports.map((transport) => transport.startClose()));
      }
    });
  });
});

it("joins captured domain cleanup before retiring its pool and execution generation", async () => {
  const { location, authority } = readFixture();
  const scope = new AsyncLocalStorage<string>();
  const ownerCloseStarted = createDeferredCore();
  const ownerMayClose = createDeferredCore();
  const events: string[] = [];
  const record = (event: string) => async () => {
    events.push(event);
  };
  const releaseGeneration = vi.fn(record("generation released"));
  mock.closeResources.mockImplementation(record("resources closed"));
  mock.closePool.mockImplementation(record("pool closed"));
  let captured: ReturnType<typeof captureOpenClawStateReadSource> | undefined;
  const generation = withRuntimeWorkerGeneration(async (bind) => {
    bind((url) => new URL(`${url.href}?synthetic-generation=owned`));
    captured = captureOpenClawStateReadSource();
    const retainedSource = captured;
    const transport = retainedSource.createTransport(backupRead);
    readyTask();
    scope.run("accepted reader", () => {
      const unregister = retainedSource.own(async () => {
        expect(scope.getStore()).toBe("accepted reader");
        events.push("domain closing");
        ownerCloseStarted.resolve();
        await ownerMayClose.promise;
        await transport.startRead(location, authority);
        await transport.startClose();
        unregister();
        events.push("domain closed");
      });
    });
  }, releaseGeneration);
  try {
    await Promise.race([
      ownerCloseStarted.promise,
      generation.then(() => {
        throw new Error("Generation completed before domain cleanup");
      }),
    ]);
    expect(events).toEqual(["domain closing"]);
    expect(mock.create).not.toHaveBeenCalled();
    expect(() => captured?.own(async () => {})).toThrow(/closing/);
  } finally {
    ownerMayClose.resolve();
    await generation;
  }
  expect(events).toEqual([
    "domain closing",
    "domain closed",
    "resources closed",
    "pool closed",
    "generation released",
  ]);
});
