import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { isToolResultError } from "../tool-result-error.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

function setup(options: Parameters<typeof createSessionsYieldTool>[0] = {}) {
  const onYield = vi.fn();
  const tool = createSessionsYieldTool({ sessionId: "test-session", onYield, ...options });
  return { onYield, tool, execute: (args = {}) => tool.execute("call-1", args) };
}

describe("sessions_yield tool", () => {
  it("defers without error or yielding when earlier async results are unobserved", async () => {
    const claimYield = vi.fn(() => true);
    const { onYield, tool } = setup({ claimYield });
    const result = await runWithAgentToolExecutionContext(
      {
        assistantMessage: makeAgentAssistantMessage({
          content: [],
          api: "test-api",
          provider: "test-provider",
          stopReason: "toolUse",
        }),
        toolCall: { type: "toolCall", id: "call-1", name: "sessions_yield", arguments: {} },
        hasUnobservedAsyncToolResults: true,
      },
      () => tool.execute("call-1", {}),
    );

    expect(result.details).toMatchObject({ status: "deferred" });
    expect(isToolResultError(result)).toBe(false);
    expect(claimYield).not.toHaveBeenCalled();
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no session context", options: { sessionId: undefined }, error: "No session context" },
    {
      name: "no callback",
      options: { onYield: undefined },
      error: "Yield not supported in this context",
    },
    {
      name: "a rejected claim",
      options: { claimYield: () => ({ error: "Yield unsupported for this session kind" }) },
      error: "Yield unsupported for this session kind",
    },
  ])("returns the specific error for $name without yielding", async ({ options, error }) => {
    const { onYield, execute } = setup(options);
    expect((await execute()).details).toMatchObject({ status: "error", error });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("claims completion ownership before aborting the requester run", async () => {
    const order: string[] = [];
    const { execute } = setup({
      claimYield: () => {
        order.push("claim");
        return true;
      },
      onYield: () => {
        order.push("abort");
      },
    });

    await execute();

    expect(order).toEqual(["claim", "abort"]);
  });

  it("keeps the turn active without a tool failure when it owns no pending child completion", async () => {
    const { onYield, execute } = setup({ claimYield: () => false });
    const result = await execute();

    expect(isToolResultError(result)).toBe(false);
    expect(result.details).toMatchObject({
      status: "nothing_pending",
      message: expect.stringContaining("did not pause the turn or schedule a continuation"),
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("does not ask an ineligible caller to repeat explicit message intent", async () => {
    const { onYield, execute } = setup({ sessionId: "root", claimYield: () => false });
    const result = await execute({ waitFor: "message" });
    expect(result.details).toMatchObject({
      status: "nothing_pending",
      message: expect.stringContaining("eligible active native task"),
    });
    expect(JSON.stringify(result)).not.toContain("set waitFor");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("explains that a paused child needs a continuation without claiming a new yield", async () => {
    const pendingChildren = [
      {
        runId: "run-paused",
        childSessionKey: "agent:main:subagent:worker",
        startedAt: Date.UTC(2026, 8, 21, 3, 0, 0),
        state: "paused" as const,
        wakeArmed: false,
      },
    ];
    const { onYield, execute } = setup({ claimYield: () => ({ pendingChildren }) });
    const result = await execute();
    expect(isToolResultError(result)).toBe(false);
    expect(result.details).toMatchObject({
      status: "already_pending",
      message:
        "1 child session spawned by an earlier turn of this session is paused by its own sessions_yield and will not complete until an incoming continuation arrives: agent:main:subagent:worker, paused, started 2026-09-21T03:00:00.000Z. An authorized caller can send that continuation with sessions_send; owning a child does not grant that tool. Otherwise the work stays waiting. This turn owns no new claim, so no yield is needed: end this turn normally.",
    });
    expect(result.details).toHaveProperty("pendingChildren", pendingChildren);
    expect(onYield).not.toHaveBeenCalled();
  });

  it("passes explicit message intent to its owner without treating private text as intent", async () => {
    const claimYield = vi.fn(() => true);
    const { onYield, tool } = setup({ sessionId: "child-session", claimYield });
    await tool.execute("private-text", { message: 'waitFor: "message"' });
    expect(claimYield).toHaveBeenLastCalledWith(undefined);
    await tool.execute("explicit-message", { waitFor: "message" });
    expect(claimYield).toHaveBeenLastCalledWith({ waitFor: "message" });
    const invalid = await tool.execute("invalid-intent", { waitFor: "anything" });
    expect(invalid.details).toMatchObject({ status: "error" });
    expect(claimYield).toHaveBeenCalledTimes(2);
    expect(onYield).toHaveBeenCalledTimes(2);
  });
});
