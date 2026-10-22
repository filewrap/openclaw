import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig as Config } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  collectSandboxDangerousConfigFindings,
  collectSandboxDockerNoopFindings,
} from "./audit-extra.sync.js";

function sandboxConfig(
  sandbox: NonNullable<NonNullable<Config["agents"]>["defaults"]>["sandbox"],
  entries?: NonNullable<Config["agents"]>["entries"],
): Config {
  return {
    agents: { ...(sandbox ? { defaults: { sandbox } } : {}), ...(entries ? { entries } : {}) },
  };
}
const image = { image: "ghcr.io/example/sandbox:latest" };
const finding = (suffix: string, extra = {}) =>
  expect.objectContaining({ checkId: `sandbox.${suffix}`, ...extra });
const critical = (suffix: string, title?: string) =>
  finding(suffix, { severity: "critical", ...(title ? { title } : {}) });
describe("security audit sandbox docker config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each<{ name: string; build: (home: string) => Config; expected: unknown[]; absent?: string }>`
    name                              | build                                                                                                                                                                                 | expected                                                                                                                  | absent
    ${"mode off"}                     | ${() => sandboxConfig({ mode: "off", docker: image })}                                                                                                                                | ${[finding("docker_config_mode_off")]}                                                                                    | ${undefined}
    ${"agent enables sandbox"}        | ${() => sandboxConfig({ mode: "off", docker: image }, { ops: { sandbox: { mode: "all" } } })}                                                                                         | ${[]}                                                                                                                     | ${"docker_config_mode_off"}
    ${"dangerous isolation settings"} | ${() => sandboxConfig({ mode: "all", docker: { binds: ["/etc/passwd:/mnt/passwd:ro", "/run:/run"], network: "host", seccompProfile: "unconfined", apparmorProfile: "unconfined" } })} | ${["bind_mount", "network_mode", "seccomp_profile", "apparmor_profile"].map((suffix) => critical(`dangerous_${suffix}`))} | ${undefined}
    ${"home credential bind"}         | ${(home: string) => sandboxConfig({ mode: "all", docker: { binds: [path.join(home, ".docker", "config.json") + ":/mnt/docker:ro"] } })}                                               | ${[critical("dangerous_bind_mount", "Dangerous bind mount in sandbox config")]}                                           | ${undefined}
    ${"Windows absolute bind"}        | ${() => sandboxConfig({ mode: "all", docker: { binds: ["D:/data/openclaw/src:/src:ro"] } })}                                                                                          | ${[]}                                                                                                                     | ${"bind_mount_non_absolute"}
    ${"container namespace join"}     | ${() => sandboxConfig({ mode: "all", docker: { network: "container:peer" } })}                                                                                                        | ${[critical("dangerous_network_mode", "Dangerous network mode in sandbox config")]}                                       | ${undefined}
  `("evaluates $name", async ({ name, build, expected, absent }) => {
    const isolatedHome = path.join(os.tmpdir(), "openclaw-security-audit-home");
    vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);
    await withEnvAsync({ HOME: isolatedHome, USERPROFILE: isolatedHome }, async () => {
      const cfg = build(isolatedHome);
      const findings = [
        ...collectSandboxDockerNoopFindings(cfg),
        ...collectSandboxDangerousConfigFindings(cfg),
      ];
      for (const match of expected) {
        expect(findings, name).toContainEqual(match);
      }
      if (absent) {
        expect(findings, name).not.toContainEqual(finding(absent));
      }
    });
  });
  it("reports canonical agent paths", () => {
    const cfg = sandboxConfig(undefined, {
      ops: {
        sandbox: { mode: "off", docker: { ...image, binds: ["/etc/passwd:/mnt/passwd:ro"] } },
      },
    });
    const noOp = collectSandboxDockerNoopFindings(cfg).find(
      (entry) => entry.checkId === "sandbox.docker_config_mode_off",
    );
    expect(noOp?.detail).toContain("agents.entries.ops.sandbox.docker");
    const dangerous = collectSandboxDangerousConfigFindings(cfg).find(
      (entry) => entry.checkId === "sandbox.dangerous_bind_mount",
    );
    expect(dangerous?.detail).toContain("agents.entries.ops.sandbox.docker.binds");
  });
});
