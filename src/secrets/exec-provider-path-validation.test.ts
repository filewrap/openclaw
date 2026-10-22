import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedWindowsAclVerificationUnavailable } from "../test-utils/vitest-spies.js";
import { assertSecureExecCommandPath } from "./exec-provider-path-validation.js";

describe("exec provider command path validation", () => {
  const itPosix = it.skipIf(process.platform === "win32");
  let fixtureRoot = "";
  let validExecutablePath = "";
  let executionMarkerPath = "";
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const check = (command: string, trustedDirs?: string[]) =>
    assertSecureExecCommandPath({
      command,
      label: "secrets.providers.execmain.command",
      trustedDirs,
    });
  const createScript = async (contents: string, mode: number) => {
    const scriptPath = path.join(fixtureRoot, `helper-${mode}`);
    await fs.writeFile(scriptPath, contents);
    await fs.chmod(scriptPath, mode);
    return scriptPath;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.realpath(tempDirs.make("exec-provider-path-validation-"));
    validExecutablePath = path.join(fixtureRoot, "valid-executable");
    executionMarkerPath = path.join(fixtureRoot, "executed");
    await fs.writeFile(
      validExecutablePath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(executionMarkerPath)}, "executed");\n`,
    );
    await fs.chmod(validExecutablePath, 0o755);
  });

  it("accepts a valid regular executable without executing it", async () => {
    const securePath = await check(validExecutablePath);
    expect(securePath).toBe(validExecutablePath);
    await expect(fs.access(executionMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("rejects missing command paths", async () => {
    await expect(check(path.join(fixtureRoot, "no-such-binary"))).rejects.toThrow(
      "is not readable",
    );
  });

  itPosix("rejects directory command paths", async () => {
    await expect(check(fixtureRoot)).rejects.toThrow("must be a file");
  });

  itPosix("rejects symlinked command paths", async () => {
    const symlinkPath = path.join(fixtureRoot, "exec-link");
    await fs.symlink(validExecutablePath, symlinkPath);
    await expect(check(symlinkPath)).rejects.toThrow("must not be a symlink");
  });

  itPosix("rejects world-writable command paths", async () => {
    const scriptPath = await createScript("#!/bin/sh\nexit 0\n", 0o666);
    await expect(check(scriptPath)).rejects.toThrow("permissions are too open");
  });

  itPosix("accepts regular files lacking the owner-execute bit (startup parity)", async () => {
    const scriptPath = await createScript("not executable\n", 0o600);
    await expect(check(scriptPath)).resolves.toBe(scriptPath);
  });

  itPosix("rejects commands outside trustedDirs", async () => {
    const trustedDir = path.join(fixtureRoot, "trusted");
    await fs.mkdir(trustedDir);
    await expect(check(validExecutablePath, [trustedDir])).rejects.toThrow(
      "is outside trustedDirs",
    );
  });

  itPosix("accepts a regular command inside trustedDirs", async () => {
    const copy = await createScript("#!/bin/sh\nexit 1\n", 0o755);
    await expect(check(copy, [path.dirname(copy)])).resolves.toBe(copy);
  });

  it("fails closed with a supported recovery message when Windows ACL verification is unavailable", async () => {
    await withMockedWindowsAclVerificationUnavailable(
      path.join(fixtureRoot, "missing-windows-system-root"),
      async () => {
        await expect(check(validExecutablePath)).rejects.toMatchObject({
          code: "permission-unverified",
          message: expect.stringMatching(
            /ACL verification unavailable on Windows.*no provider-level bypass/,
          ),
        });
      },
    );
  });
});
