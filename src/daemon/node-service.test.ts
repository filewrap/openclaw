import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveNodeService } from "./node-service.js";
import { withDaemonRuntimePinMigration } from "./runtime-pin-state.js";

vi.mock("./launchd-system.js", async (original) => ({
  ...(await original<typeof import("./launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
}));
vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: async () => ({
    code: 113,
    stdout: "",
    stderr: "Could not find service",
    termination: "exit" as const,
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it("stages and reads separate node definitions for two profiles beside the default", async () => {
  const home = dirs.make("openclaw-node-profiles-");
  await withEnvAsync({ HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") }, async () => {
    // Create private stores on the real host before selecting the launchd adapter.
    await withDaemonRuntimePinMigration(process.env, () => undefined);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const service = resolveNodeService();
    for (const profile of [undefined, "work", "other"]) {
      const env = { ...process.env, OPENCLAW_PROFILE: profile };
      await service.stage({
        env,
        environment: { HOME: home },
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "node", "run"],
      });
    }
    for (const profile of [undefined, "work", "other"]) {
      const label = profile ? `ai.openclaw.node.${profile}` : "ai.openclaw.node";
      const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      await expect(fs.readFile(file, "utf8")).resolves.toContain(`<string>${label}</string>`);
      const command = await service.readCommand({ ...process.env, OPENCLAW_PROFILE: profile });
      expect(command).toMatchObject({
        sourcePath: file,
        environment: { OPENCLAW_LAUNCHD_LABEL: label },
      });
      expect(command?.environment?.OPENCLAW_PROFILE).toBe(profile);
    }
  });
});
