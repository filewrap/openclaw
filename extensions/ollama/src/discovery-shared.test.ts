import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";
import {
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
} from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([
    undefined,
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://[::ffff:7f00:2]:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://10.0.0.5:11434",
    "http://172.16.0.10:11434",
    "http://172.31.255.254:11434",
    "http://192.168.1.100:11434",
    "http://gpu-node-1:11434",
    "http://mac-studio.local:11434",
    "http://docker.orb.internal:11434",
    "http://host.docker.internal:11434",
    "http://host.orb.internal:11434",
    "http://[fd00::1]:11434",
    "http://[fe90::1]:11434",
  ])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    "https://ollama.com",
    "https://ollama.example.com:11434",
    "http://8.8.8.8:11434",
    "http://172.15.255.254:11434",
    "http://172.32.0.1:11434",
    "http://193.168.1.1:11434",
    "http://[2001:4860:4860::8888]:11434",
    "http://[::ffff:10.0.0.5]:11434",
    "http://10.example.com:11434",
    "not a url",
  ])("classifies %s as remote", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
  });
});

const discoveredModel = {
  ...createModel("discovered-model", "discovered-model"),
  compat: { supportsTools: true, supportsUsageInStreaming: true },
  params: { num_ctx: 128000 },
} satisfies ModelProviderConfig["models"][number];

const cloudModel = {
  ...discoveredModel,
  id: "minimax-m3:cloud",
  name: "minimax-m3:cloud",
  contextTokens: 24_000,
  params: { num_ctx: 48_000 },
} satisfies ModelProviderConfig["models"][number];
const localUrl = "http://127.0.0.1:11434";
const secretRef = (source: "env" | "file" | "exec", id: string) =>
  ({ source, provider: "default", id }) as const;
const makeProvider = (baseUrl: string): ModelProviderConfig => ({
  baseUrl,
  api: "ollama",
  models: [discoveredModel],
});

type DiscoveryParams = Parameters<typeof resolveOllamaDiscoveryResult>[0];
type DiscoveryAuth = ReturnType<DiscoveryParams["ctx"]["resolveProviderApiKey"]>;

const buildMockProvider = async () => makeProvider("https://ollama.com");
const discoveryOptions = (apiKey?: string) => ({
  onListedModels: expect.any(Function),
  discoveryMode: "strict",
  ...(apiKey ? { apiKey } : {}),
});

function discover(
  provider: Partial<ModelProviderConfig>,
  options: {
    resolvedAuth?: DiscoveryAuth;
    env?: NodeJS.ProcessEnv;
    buildProvider?: DiscoveryParams["buildProvider"];
  } = {},
) {
  return resolveOllamaDiscoveryResult({
    ctx: {
      config: { models: { providers: { ollama: { api: "ollama", ...provider } } } },
      env: options.env ?? {},
      resolveProviderApiKey: () => options.resolvedAuth ?? {},
    },
    pluginConfig: {},
    buildProvider: options.buildProvider ?? buildMockProvider,
  });
}

async function expectResolvedAuth(
  baseUrl: string,
  owner: string,
  apiKey: ReturnType<typeof secretRef>,
  marker: string,
  secret: string,
) {
  const buildProvider = vi.fn(async () => makeProvider(baseUrl.replace(/\/v1$/, "")));
  const result = await discover(
    { baseUrl, ...(owner === "config" ? { apiKey, models: [cloudModel] } : {}) },
    {
      env: { OLLAMA_API_KEY: "different-ambient-ollama-credential", RESOLVED_OLLAMA_TOKEN: secret },
      resolvedAuth: { apiKey: marker, discoveryApiKey: secret },
      buildProvider,
    },
  );
  expect(buildProvider).toHaveBeenCalledExactlyOnceWith(baseUrl, discoveryOptions(secret));
  expect(result).toMatchObject({
    provider: { apiKey: owner === "config" ? apiKey : marker, models: [discoveredModel] },
  });
}

describe("configured Ollama thinking metadata", () => {
  it.each<{
    name: string;
    api: ModelProviderConfig["api"];
    model: Partial<ModelProviderConfig["models"][number]>;
  }>([
    { name: "an explicit map", api: "ollama", model: { thinkingLevelMap: { off: "false" } } },
    { name: "a model API override", api: "ollama", model: { api: "openai-completions" } },
    { name: "a provider API override", api: "openai-completions", model: {} },
    { name: "another endpoint", api: "ollama", model: { baseUrl: "http://127.0.0.2:11434" } },
  ])("does not replace $name with discovered native metadata", async ({ api, model }) => {
    const result = await discover(
      {
        baseUrl: "http://localhost:11434",
        api,
        models: [{ ...discoveredModel, ...model }],
      },
      {
        buildProvider: async () => ({
          baseUrl: "http://localhost:11434",
          api: "ollama",
          models: [{ ...discoveredModel, thinkingLevelMap: { off: "true", low: "true" } }],
        }),
      },
    );
    expect(result).toMatchObject({
      provider: { models: [] },
      outcomes: [{ provider: "ollama", status: "ready" }],
    });
  });
});

describe("resolveOllamaDiscoveryResult — hosted Ollama Cloud guard", () => {
  it.each([
    [secretRef("env", "MISSING_OLLAMA_TOKEN"), undefined, true],
    [secretRef("env", "MISSING_OLLAMA_TOKEN"), "MISSING_OLLAMA_TOKEN", true],
    [secretRef("file", "/missing-ollama-token"), "secretref-managed", true],
    [secretRef("exec", "missing-ollama-token"), "secretref-managed", false],
    ["${MISSING_OLLAMA_TOKEN}", undefined, false],
  ] as const)(
    "does not replace unresolved %j (%s) with synthetic auth",
    async (apiKey, marker, models) => {
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(
        {
          baseUrl: models ? localUrl : "http://192.168.10.8:11434",
          apiKey,
          ...(models ? { models: [cloudModel] } : {}),
        },
        {
          resolvedAuth: { apiKey: marker },
          buildProvider,
        },
      );

      expect(result).toBeNull();
      expect(buildProvider).not.toHaveBeenCalled();
    },
  );

  it.each(["https://ollama.com", "https://api.ollama.com/v1", "https://sub.ollama.com"])(
    "returns null for hosted base URL %s without explicit models",
    async (baseUrl) => {
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(
        { baseUrl, apiKey: "test-key" },
        { resolvedAuth: { apiKey: "test-key" }, buildProvider },
      );
      expect(result).toBeNull();
      expect(buildProvider).not.toHaveBeenCalled();
    },
  );

  it("returns explicit models for remote base URL when models are configured", async () => {
    const result = await discover(
      { baseUrl: "https://ollama.com", apiKey: "test-key", models: [cloudModel] },
      { resolvedAuth: { apiKey: "test-key" } },
    );
    expect(result).toMatchObject({ provider: { models: [cloudModel] } });
  });

  it.each(["127.1.2.3", "[::ffff:7f00:2]", "10.0.0.5"])(
    "keeps ambient cloud credentials away from the local endpoint %s",
    async (hostname) => {
      const provider = {
        baseUrl: `http://${hostname}:11434`,
        api: "ollama" as const,
        models: [cloudModel],
      };
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(provider, {
        env: { OLLAMA_API_KEY: "ambient-cloud-credential" },
        buildProvider,
      });
      expect(buildProvider).toHaveBeenCalledExactlyOnceWith(provider.baseUrl, discoveryOptions());
      expect(result).toMatchObject({ provider: { apiKey: "ollama-local" } });
      expect(shouldUseSyntheticOllamaAuth(provider)).toBe(true);
    },
  );

  it.each([undefined, "http://localhost:11434", "https://ollama.mycompany.com", "not a url"])(
    "still auto-discovers for non-hosted base URL %s",
    async (baseUrl) => {
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(
        { baseUrl, apiKey: "test-key" },
        { resolvedAuth: { apiKey: "test-key" }, buildProvider },
      );
      expect(result).toMatchObject({
        provider: { api: "ollama", apiKey: "test-key", models: [discoveredModel] },
        outcomes: [{ provider: "ollama", status: "ready" }],
      });
      expect(buildProvider).toHaveBeenCalledExactlyOnceWith(baseUrl, discoveryOptions("test-key"));
    },
  );

  it.each(
    ["https://ollama-secure.example/v1", localUrl].flatMap((baseUrl) =>
      ["config", "profile"].map((owner) => ({ baseUrl, owner })),
    ),
  )(
    "authenticates live discovery at $baseUrl with its resolved $owner SecretRef",
    async ({ baseUrl, owner }) => {
      const apiKey = secretRef("env", "OLLAMA_DISCOVERY_TOKEN");
      const marker = owner === "config" ? apiKey.id : "secretref-managed";
      await expectResolvedAuth(baseUrl, owner, apiKey, marker, "resolved-ollama-discovery-token");
    },
  );

  it.each([
    { secretValue: "OLLAMA_API_KEY", owner: "config", baseUrl: "https://opaque-secretref.example" },
    { secretValue: "ollama-local", owner: "config", baseUrl: "http://127.0.0.1:11434" },
    { secretValue: "ollama-local", owner: "profile", baseUrl: "https://opaque-secretref.example" },
    { secretValue: "OLLAMA_API_KEY", owner: "profile", baseUrl: "http://127.0.0.1:11434" },
  ])(
    "preserves resolved opaque $owner SecretRef credential $secretValue at $baseUrl",
    async ({ secretValue, owner, baseUrl }) => {
      await expectResolvedAuth(
        baseUrl,
        owner,
        secretRef("file", "/ollama/apiKey"),
        "secretref-managed",
        secretValue,
      );
    },
  );
});

describe("shouldUseSyntheticOllamaAuth", () => {
  it.each([
    [secretRef("env", "MISSING_OLLAMA_TOKEN"), false],
    ["configured-ollama-fixture", false],
    [undefined, true],
    ["ollama-local", true],
    ["OLLAMA_API_KEY", true],
  ] as const)("preserves %j ownership", (apiKey, synthetic) => {
    expect(
      shouldUseSyntheticOllamaAuth({
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey,
        models: [discoveredModel],
      }),
    ).toBe(synthetic);
  });
});
