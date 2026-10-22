import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";
import { resolveTelegramToken } from "./token.js";

function config(
  telegram: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
  secrets?: OpenClawConfig["secrets"],
): OpenClawConfig {
  return { channels: { telegram }, ...(secrets ? { secrets } : {}) };
}

function envRef(provider = "telegram-env", id = "TELEGRAM_BOT_TOKEN") {
  return { source: "env" as const, provider, id };
}

describe("resolveTelegramBotUserIdFromToken", () => {
  it.each([
    ["not-a-bot:secret", undefined],
    ["9007199254740992:secret", undefined],
  ])("parses %j as %j", (token, expected) => {
    expect(resolveTelegramBotUserIdFromToken(token)).toBe(expected);
  });
});

describe("resolveTelegramToken", () => {
  const tempWorkspaces: TempWorkspaceSync[] = [];
  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-telegram-token-",
    });
    tempWorkspaces.push(workspace);
    const tokenFile = path.join(workspace.dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf-8");
    return tokenFile;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
  });

  it.runIf(process.platform !== "win32")(
    "marks symlinked tokenFile paths configured-unavailable",
    () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const tokenFile = createTokenFile("token.txt");
      const tokenLink = path.join(path.dirname(tokenFile), "token-link.txt");
      fs.symlinkSync(tokenFile, tokenLink);

      const cfg = config({ tokenFile: tokenLink, botToken: "fallback-token" });
      const result = resolveTelegramToken(cfg);
      expect(result).toEqual({
        token: "",
        source: "tokenFile",
        credentialDiagnostics: [
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.telegram.tokenFile",
            reason: "symlink",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(tokenLink);
    },
  );

  it("applies account file, account config, channel file, channel config, then env precedence", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const accountTokenFile = createTokenFile("account-token.txt", "account-file-token\n");
    const channelTokenFile = createTokenFile("channel-token.txt", "channel-file-token\n");
    const channel = { botToken: "channel-config-token", tokenFile: channelTokenFile };
    const account = { botToken: "account-config-token", tokenFile: accountTokenFile };
    for (const [root, selected, token, source] of [
      [channel, account, "account-file-token", "tokenFile"],
      [channel, { botToken: account.botToken }, "account-config-token", "config"],
      [channel, {}, "channel-file-token", "tokenFile"],
      [{ botToken: channel.botToken }, {}, "channel-config-token", "config"],
      [{}, {}, "env-token", "env"],
    ] as const) {
      expect(resolveTelegramToken(config({ ...root, accounts: { default: selected } }))).toEqual({
        token,
        source,
      });
    }
  });

  it("does not use env token for non-default accounts", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = config({ accounts: { work: {} } });
    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res).toEqual({ token: "", source: "none" });
  });

  it("does not fall through to channel-level token when non-default accountId is not in config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = config({
      botToken: "wrong-bot-token",
      accounts: { knownBot: { botToken: "known-bot-token" } },
    });
    expect(resolveTelegramToken(cfg, { accountId: "unknownBot" })).toEqual({
      token: "",
      source: "none",
    });
  });

  it("does not fall back to TELEGRAM_BOT_TOKEN when a selected ref is unavailable", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fallback-env-token");
    vi.stubEnv("TELEGRAM_REF_TOKEN", "");
    const cfg = config({ botToken: envRef("default", "TELEGRAM_REF_TOKEN") });

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "",
      source: "none",
    });
  });

  it.each([[], ["TELEGRAM_BOT_TOKEN"]].map((allowlist) => ({ allowlist })))(
    "honors the selected explicit env provider allowlist $allowlist",
    ({ allowlist }) => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
      const cfg = config(
        { botToken: envRef() },
        {
          defaults: { env: "telegram-env" },
          providers: { "telegram-env": { source: "env", allowlist } },
        },
      );

      if (allowlist.includes("TELEGRAM_BOT_TOKEN")) {
        expect(resolveTelegramToken(cfg)).toEqual({
          token: "secretref-env-token",
          source: "config",
        });
      } else {
        expect(() => resolveTelegramToken(cfg)).toThrow(
          /not allowlisted in secrets\.providers\.telegram-env\.allowlist/i,
        );
      }
    },
  );

  it.each([
    [
      envRef(),
      { providers: { "telegram-env": { source: "file", path: "/tmp/secrets.json" } } },
      /Secret provider "telegram-env" has source "file" but ref requests "env"/i,
    ],
    [
      envRef("ops-env"),
      undefined,
      /Secret provider "ops-env" is not configured \(ref: env:ops-env:TELEGRAM_BOT_TOKEN\)/i,
    ],
    [
      { source: "file", provider: "vault", id: "/telegram/bot-token" },
      undefined,
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    ],
  ] as const)("rejects unavailable SecretRef %j", (botToken, secrets, error) => {
    expect(() => resolveTelegramToken(config({ botToken }, secrets))).toThrow(error);
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    const cfg = config({ botToken: "channel-level-token", enabled: true });

    const res = resolveTelegramToken(cfg, { accountId: "bot-main" });
    expect(res).toEqual({ token: "channel-level-token", source: "config" });
  });
});
