import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createOllamaEmbeddingProvider } from "./embedding-provider.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const { fetchConfiguredLocalOriginWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchConfiguredLocalOriginWithSsrFGuardMock: vi.fn(
    async ({ init, url }: { init?: RequestInit; url: string }) => ({
      response: await fetch(url, init),
      release: async () => {},
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
  formatErrorMessage: coerceErrorMessage,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => {
    const parsed = new URL(baseUrl);
    return { allowedOrigins: [parsed.origin] };
  },
}));

// Import-resolution gating for this private helper is covered in sdk-alias.test.ts.
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  fetchConfiguredLocalOriginWithSsrFGuard: fetchConfiguredLocalOriginWithSsrFGuardMock,
}));

beforeEach(() => {
  fetchConfiguredLocalOriginWithSsrFGuardMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type EmbeddingProviderOptions = Parameters<typeof createOllamaEmbeddingProvider>[0];
type MemoryEmbeddingOptions = Parameters<typeof ollamaMemoryEmbeddingProviderAdapter.create>[0];

function createProviderConfig(
  provider: Record<string, unknown>,
  providerId = "ollama",
): OpenClawConfig {
  return { models: { providers: { [providerId]: provider } } } as unknown as OpenClawConfig;
}

const PRIVATE_HOST = "https://selected-private-host.invalid";
const REMOTE_HOST = "https://remote-embedding-host.invalid";
const SELECTED_KEY = "synthetic-selected-host-key";
const REMOTE_KEY = "synthetic-remote-key";
function selectedConfig(provider: Record<string, unknown> = {}) {
  return createProviderConfig({ baseUrl: `${PRIVATE_HOST}/v1`, models: [], ...provider });
}

function embeddingOptions<T extends EmbeddingProviderOptions | MemoryEmbeddingOptions>(
  overrides: Partial<T> = {},
): T {
  return {
    config: {} as OpenClawConfig,
    provider: "ollama",
    model: "nomic-embed-text",
    fallback: "none",
    ...(overrides.config ? {} : { remote: { baseUrl: "http://127.0.0.1:11434" } }),
    ...overrides,
  } as T;
}

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

async function createEmbeddingProvider(overrides: Partial<EmbeddingProviderOptions> = {}) {
  return await createOllamaEmbeddingProvider(embeddingOptions(overrides));
}

async function createMemoryEmbeddingProvider(overrides: Partial<MemoryEmbeddingOptions> = {}) {
  return await ollamaMemoryEmbeddingProviderAdapter.create(embeddingOptions(overrides));
}

function mockEmbeddingResponse(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function embeddingResponse(embeddings: unknown[], prompt_eval_count?: unknown) {
  return new Response(JSON.stringify({ embeddings, prompt_eval_count }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockEmbeddingFetch(embedding: number[]) {
  return mockEmbeddingResponse(embeddingResponse([embedding]));
}

function mockBatchEmbeddingFetch(count: number, promptEvalCount?: unknown) {
  const inputs: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    inputs.push(readEmbeddingRequestBody(init).input);
    return embeddingResponse(
      Array.from({ length: count }, () => [1, 0]),
      promptEvalCount,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, inputs };
}

async function embedTestQuery(overrides: Partial<EmbeddingProviderOptions> = {}, query = "hello") {
  const fetchMock = mockEmbeddingFetch([1, 0]);
  const { provider } = await createEmbeddingProvider(overrides);
  await provider.embed(query, { inputType: "query" });
  return { fetchMock, provider };
}

function firstFetchInit(fetchMock: ReturnType<typeof mockEmbeddingFetch>): RequestInit | undefined {
  const call = fetchMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected embedding fetch call");
  }
  return call[1] as RequestInit | undefined;
}

function readEmbeddingRequestBody(init: RequestInit | undefined): { input?: unknown } {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(init.body) as { input?: unknown };
}

function firstGuardedFetchCall(): Record<string, unknown> {
  const call = fetchConfiguredLocalOriginWithSsrFGuardMock.mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("expected guarded fetch call");
  }
  return call as Record<string, unknown>;
}

function expectEmbeddingFetch(
  fetchMock: ReturnType<typeof mockEmbeddingFetch>,
  url: string,
  params: {
    model?: string;
    input?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  expect(fetchMock).toHaveBeenCalledWith(url, {
    method: "POST",
    headers: params.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model ?? "nomic-embed-text",
      input: params.input ?? "hello",
    }),
  });
}

describe("ollama embedding provider", () => {
  it("applies outputDimensionality before normalizing vectors", async () => {
    mockEmbeddingFetch([3, 4, 12]);

    const { provider } = await createEmbeddingProvider({
      model: "unknown-embedder",
      dimensions: 2,
    });

    const vector = await provider.embed("hi", { inputType: "query" });

    expect(vector).toHaveLength(2);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves configured base URL and headers without sending local marker auth", async () => {
    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama-\nlocal\r\n", // pragma: allowlist secret
        headers: { "X-Provider-Header": "provider" },
      }),
      model: "",
    });

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Header": "provider",
      },
    });
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createEmbeddingProvider({
        remote: {
          baseUrl: "http://127.0.0.1:11434",
          apiKey: envRef("OLLAMA_API_KEY"),
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("resolves selected provider credential and header SecretRefs before ambient cloud auth", async () => {
    const providerId = "ollama-private";
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
    vi.stubEnv("OLLAMA_PROXY_KEY", "synthetic-proxy-key");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig(
        {
          baseUrl: "https://selected-private-host.invalid/v1",
          apiKey: envRef("OLLAMA_SELECTED_HOST_KEY"),
          headers: {
            "X-Proxy-Auth": envRef("OLLAMA_PROXY_KEY"),
          },
          models: [],
        },
        providerId,
      ),
      provider: providerId,
    });

    expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Auth": "synthetic-proxy-key",
        Authorization: "Bearer synthetic-selected-host-key",
      },
    });
  });

  it.each([
    { providerId: "ollama-private", surface: "apiKey", source: "env" },
    { providerId: "ollama-private", surface: "headers", source: "exec" },
  ])(
    "fails closed before any request for unresolved $providerId $surface $source SecretRefs",
    async ({ providerId, surface, source }) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
      vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
      vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");
      const fetchMock = mockEmbeddingFetch([1, 0]);
      const unavailableSecret = {
        source,
        provider: "default",
        id:
          source === "exec" ? "synthetic-missing-ollama-secret" : "OLLAMA_MISSING_SELECTED_SECRET",
      };

      await expect(
        createEmbeddingProvider({
          config: createProviderConfig(
            {
              baseUrl: "https://selected-private-host.invalid/v1",
              apiKey: surface === "apiKey" ? unavailableSecret : envRef("OLLAMA_SELECTED_HOST_KEY"),
              ...(surface === "headers"
                ? {
                    headers: {
                      "X-Proxy-Auth": unavailableSecret,
                    },
                  }
                : {}),
              models: [],
            },
            providerId,
          ),
          provider: providerId,
        }),
      ).rejects.toThrow(
        `models.providers["${providerId}"].${
          surface === "headers" ? 'headers["X-Proxy-Auth"]' : "apiKey"
        }`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fetchConfiguredLocalOriginWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit selected-host SecretRef values opaque", async () => {
    const resolvedSecret = "ollama-local";
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", resolvedSecret);

    const { fetchMock } = await embedTestQuery({
      config: selectedConfig({
        apiKey: envRef("OLLAMA_SELECTED_HOST_KEY"),
      }),
    });

    expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolvedSecret}`,
      },
    });
  });

  it.each([7, -1])("sends one batch and reports native usage %s", async (tokens) => {
    const { fetchMock, inputs } = mockBatchEmbeddingFetch(3, tokens);

    const { provider } = await createEmbeddingProvider();

    const onUsage = vi.fn();
    await expect(provider.embedBatch(["a", "bb", "ccc"], { onUsage })).resolves.toHaveLength(3);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      tokens === 7 ? { promptTokens: tokens, totalTokens: tokens } : undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputs).toEqual([["a", "bb", "ccc"]]);
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "http://127.0.0.1:11434/api/embed",
      policy: { allowedOrigins: ["http://127.0.0.1:11434"] },
      configuredLocalOriginBaseUrl: "http://127.0.0.1:11434",
      auditContext: "ollama-memory-embedding",
    });
  });

  it("bounds embed error bodies without using response.text()", async () => {
    const tracked = createStreamingResponse({
      status: 503,
      chunkCount: 32,
      chunkSize: 1,
      text: `${"ollama embed unavailable ".repeat(1024)}tail`,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    mockEmbeddingResponse(tracked.response);

    const { provider } = await createEmbeddingProvider();

    let error: unknown;
    try {
      await provider.embed("hello", { inputType: "query" });
    } catch (err) {
      error = err;
    }

    expect(String(error)).toContain("Ollama embed HTTP 503");
    expect(String(error)).toContain("ollama embed unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("reports actionable embed errors for a missing model", async () => {
    const body = JSON.stringify({ error: 'model "all-minilm" not found, try pulling it first' });
    const fetchMock = mockEmbeddingResponse(new Response(body, { status: 404 }));
    const { provider } = await createEmbeddingProvider({ model: "all-minilm" });

    await expect(provider.embed("hello", { inputType: "query" })).rejects.toMatchObject({
      message: `Ollama embed HTTP 404: ${body} Run \`ollama pull all-minilm\` on the configured Ollama host.`,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [["0.1", 0.2], "a non-number embedding value"],
    [[], "an empty embedding"],
  ] as const)("rejects malformed embedding %j", async (embedding, error) => {
    mockEmbeddingResponse(embeddingResponse([embedding]));
    const { provider } = await createEmbeddingProvider();
    await expect(provider.embed("hello", { inputType: "query" })).rejects.toThrow(
      `Ollama embed response contains ${error}`,
    );
  });

  it("uses custom Ollama provider config and strips that provider prefix", async () => {
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const service = {
      command: "/usr/bin/ollama-spark",
      args: ["serve"],
      idleStopMs: 10,
    };

    const { fetchMock, provider } = await embedTestQuery({
      config: createProviderConfig(
        {
          baseUrl: "http://spark.local:11434/v1",
          apiKey: "spark-key",
          headers: { "X-Custom-Ollama": "spark" },
          localService: service,
          models: [],
        },
        "ollama-spark",
      ),
      provider: "ollama-spark",
      model: "ollama-spark/qwen3-embedding:4b",
      acquireLocalService,
    });

    expect(provider.model).toBe("qwen3-embedding:4b");
    expectEmbeddingFetch(fetchMock, "http://spark.local:11434/api/embed", {
      model: "qwen3-embedding:4b",
      input:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:hello",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Ollama": "spark",
        Authorization: "Bearer spark-key",
      },
    });
    expect(acquireLocalService).toHaveBeenCalledWith(
      {
        providerId: "ollama-spark",
        baseUrl: "http://spark.local:11434/v1",
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Ollama": "spark",
          Authorization: "Bearer spark-key",
        },
      },
      undefined,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not lease a configured local service for a remote endpoint override", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const { provider } = await createEmbeddingProvider({
      config: createProviderConfig(
        {
          baseUrl: "http://spark.local:11434/v1",
          localService: { command: process.execPath },
          models: [],
        },
        "ollama-spark",
      ),
      provider: "ollama-spark",
      remote: { baseUrl: "http://memory.local:11434" },
      acquireLocalService,
    });

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(acquireLocalService).not.toHaveBeenCalled();
  });

  it.each([
    ["http://127.0.0.1:11434", undefined],
    ["https://ollama.com", "Bearer ollama-cloud-key"],
  ])("scopes ambient cloud credentials for %s", async (baseUrl, authorization) => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");
    const { fetchMock } = await embedTestQuery({ remote: { baseUrl } });
    expect(new Headers(firstFetchInit(fetchMock)?.headers).get("Authorization")).toBe(
      authorization ?? null,
    );
    if (authorization) {
      expectEmbeddingFetch(fetchMock, `${baseUrl}/api/embed`, {
        input: "search_query: hello",
        headers: { "Content-Type": "application/json", Authorization: authorization },
      });
    }
  });

  it.each<{
    name: string;
    selected: Record<string, unknown>;
    remote: NonNullable<EmbeddingProviderOptions["remote"]>;
    headers: Record<string, string>;
  }>([
    {
      name: "explicit header auth leaves a competing apiKey SecretRef inactive",
      selected: { apiKey: envRef("OLLAMA_MISSING_SELECTED_SECRET") },
      remote: {
        baseUrl: PRIVATE_HOST,
        headers: { authorization: "Bearer synthetic-explicit-tenant-a" },
      },
      headers: { authorization: "Bearer synthetic-explicit-tenant-a" },
    },
    {
      name: "remote headers override selected-host SecretRefs case-insensitively",
      selected: {
        apiKey: envRef("OLLAMA_SELECTED_HOST_KEY"),
        headers: { "X-Proxy-Auth": envRef("OLLAMA_MISSING_SELECTED_SECRET") },
      },
      remote: { baseUrl: PRIVATE_HOST, headers: { "x-proxy-auth": "synthetic-remote-header" } },
      headers: {
        "x-proxy-auth": "synthetic-remote-header",
        Authorization: `Bearer ${SELECTED_KEY}`,
      },
    },
    {
      name: "a different host does not inherit a literal provider key",
      selected: { baseUrl: "http://127.0.0.1:11434", apiKey: "provider-host-key" },
      remote: { baseUrl: "https://memory.example.com" },
      headers: {},
    },
    {
      name: "a different host does not inherit selected-host SecretRefs",
      selected: {
        apiKey: envRef("OLLAMA_SELECTED_HOST_KEY"),
        headers: { "X-Selected-Host-Auth": envRef("OLLAMA_SELECTED_PROXY_KEY") },
      },
      remote: {
        baseUrl: REMOTE_HOST,
        apiKey: REMOTE_KEY,
        headers: { "X-Remote-Auth": "synthetic-remote-header" },
      },
      headers: {
        "X-Remote-Auth": "synthetic-remote-header",
        Authorization: `Bearer ${REMOTE_KEY}`,
      },
    },
    {
      name: "remote credentials leave another host's unresolved SecretRef inactive",
      selected: { apiKey: envRef("OLLAMA_MISSING_SELECTED_SECRET") },
      remote: { baseUrl: REMOTE_HOST, apiKey: REMOTE_KEY },
      headers: { Authorization: `Bearer ${REMOTE_KEY}` },
    },
    {
      name: "the remote local marker explicitly opts out of selected-host auth",
      selected: { baseUrl: "http://127.0.0.1:11434", apiKey: "provider-host-key" },
      remote: { apiKey: "ollama-local" }, // pragma: allowlist secret
      headers: {},
    },
  ])("$name", async ({ selected, remote, headers }) => {
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", SELECTED_KEY);
    vi.stubEnv("OLLAMA_SELECTED_PROXY_KEY", "synthetic-selected-proxy-key");
    vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");
    const { fetchMock } = await embedTestQuery({
      config: selectedConfig(selected),
      remote,
    });
    expectEmbeddingFetch(
      fetchMock,
      `${remote.baseUrl ?? selected.baseUrl ?? PRIVATE_HOST}/api/embed`,
      {
        input: "search_query: hello",
        headers: { "Content-Type": "application/json", ...headers },
      },
    );
  });

  it("preserves the legacy identity only for the default Ollama endpoint", async () => {
    const defaultEndpoint = await createMemoryEmbeddingProvider({ dimensions: 2 });
    const customEndpoint = await createMemoryEmbeddingProvider({
      remote: { baseUrl: "http://10.0.0.5:11434" },
      dimensions: 2,
    });

    expect(defaultEndpoint.runtime?.cacheKeyData).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      outputDimensionality: 2,
    });
    expect(customEndpoint.runtime?.cacheKeyData).toEqual({
      provider: "ollama",
      baseUrl: "http://10.0.0.5:11434",
      model: "nomic-embed-text",
      outputDimensionality: 2,
    });
  });

  // Vary the credential and the non-secret tenant header independently: only
  // the tenant may change the cache key.
  it("keys custom endpoints by non-secret headers while excluding credentials", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    const createCustomProvider = (tenant: string, apiKey: string) =>
      createMemoryEmbeddingProvider({
        config: createProviderConfig(
          {
            api: "ollama",
            baseUrl: "https://ollama-cpu.home.lab",
            headers: {
              "X-Ollama-Tenant": tenant,
              "X-Api-Key": apiKey,
            },
            models: [],
          },
          "ollama-cpu",
        ),
        provider: "ollama-cpu",
        model: "qwen3-embedding:4b",
      });
    const result = await createCustomProvider("tenant-a", "super-secret"); // pragma: allowlist secret

    await result.provider!.embed("hello", { inputType: "query" });
    expectEmbeddingFetch(fetchMock, "https://ollama-cpu.home.lab/api/embed", {
      model: "qwen3-embedding:4b",
      input:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:hello",
      headers: {
        "Content-Type": "application/json",
        "X-Ollama-Tenant": "tenant-a",
        "X-Api-Key": "super-secret", // pragma: allowlist secret
      },
    });
    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "ollama-cpu",
      baseUrl: "https://ollama-cpu.home.lab",
      model: "qwen3-embedding:4b",
      headersHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result.runtime?.cacheKeyData)).not.toContain("tenant-a");
    expect(JSON.stringify(result.runtime?.cacheKeyData)).not.toContain("super-secret");

    const rotatedCredential = await createCustomProvider("tenant-a", "rotated-fixture-key");
    expect(rotatedCredential.runtime?.cacheKeyData).toEqual(result.runtime?.cacheKeyData);

    const otherTenant = await createCustomProvider("tenant-b", "super-secret"); // pragma: allowlist secret
    expect(otherTenant.runtime?.cacheKeyData).not.toEqual(result.runtime?.cacheKeyData);
  });
});
