import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestUrl, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaBaseUrlSsrFPolicy,
  buildOllamaModelDefinition,
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  toDynamicOllamaModel,
  type OllamaTagModel,
} from "./provider-models.js";
const localUrl = "http://127.0.0.1:11434";
const completion = ["completion"];

afterEach(() => vi.unstubAllGlobals());

async function discoverModel(url = localUrl) {
  const provider = await buildOllamaProvider(url);
  const model = expectDefined(provider.models[0], "discovered model");
  return {
    model,
    runtime: toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model }),
  };
}

function stubDiscovery(models: OllamaTagModel[], show: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      jsonResponse(requestUrl(input).endsWith("/api/tags") ? { models } : show),
    ),
  );
}

describe("ollama provider models", () => {
  it.each([
    { tagSize: "1.5B", expected: 1_500_000_000 },
    { tagSize: "494M", expected: 494_000_000 },
    { tagSize: "1.2T", expected: 1_200_000_000_000 },
    { tagSize: "4B", showCount: 70_000_000_000, expected: 70_000_000_000 },
    { showSize: "32.8B", expected: 32_800_000_000 },
    { tagSize: "unknown", expected: undefined },
  ])(
    "keeps total parameter metadata through discovery: %j",
    async ({ tagSize, showCount, showSize, expected }) => {
      stubDiscovery([{ name: "custom-model", details: { parameter_size: tagSize } }], {
        capabilities: completion,
        model_info: { "general.parameter_count": showCount },
        details: { parameter_size: showSize },
      });
      const { model, runtime } = await discoverModel();
      expect([model.parameterCount, runtime.parameterCount]).toEqual([expected, expected]);
    },
  );

  it("keeps incomplete cloud metadata discoverable with remote host metadata", async () => {
    const listed = {
      name: "deepseek-r1:671b",
      remote_host: "https://ollama.example",
      capabilities: ["vision"],
    };
    stubDiscovery([listed]);

    await expect(buildOllamaProvider(localUrl)).resolves.toMatchObject({
      models: [
        {
          id: listed.name,
          input: ["text", "image"],
          reasoning: true,
          compat: { supportsTools: true },
        },
      ],
    });
  });

  it("keeps strict node discovery closed when remote completion is only inferred", async () => {
    stubDiscovery([]);

    await expect(
      enrichOllamaCompletionModels(
        localUrl,
        [
          {
            name: "remote-chat:latest",
            remote_model: "upstream-chat:latest",
            capabilities: ["tools"],
          },
        ],
        { requireCompletionCapability: true },
      ),
    ).resolves.toEqual([]);
  });

  it("reads loaded models from /api/ps with remote auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://ollama.example.com/api/ps");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { model: "llama3.3:70b" }, { name: "   " }, {}],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLoadedOllamaModelNames("https://ollama.example.com/v1", {
        apiKey: "private-key",
      }),
    ).resolves.toEqual({
      reachable: true,
      models: ["qwen3.5:4b", "llama3.3:70b"],
    });
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second, third] = await Promise.all(
      ["account-a", "account-b", "account-a"].map(
        async (apiKey) => await buildOllamaProvider("https://ollama.example.com", { apiKey }),
      ),
    );

    expect([first, second, third].map((provider) => provider?.models[0]?.contextWindow)).toEqual([
      16_000, 32_000, 16_000,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    { id: "minimax-m2.7", contextWindow: 196_608, maxTokens: 204_800 },
    { id: "minimax-m3", contextWindow: 524_288, maxTokens: 524_288 },
    { id: "kimi-k3", contextWindow: 1_048_576, maxTokens: 1_048_576 },
    { id: "glm-5.2", contextWindow: 1_000_000, maxTokens: 131_072 },
  ])("keeps the cloud output budget for $id aliases", ({ id, contextWindow, maxTokens }) => {
    for (const modelId of [id, `${id}:cloud`, `${id}-cloud`]) {
      expect(
        buildOllamaModelDefinition(modelId, undefined, undefined, { remote: true }),
      ).toMatchObject({ id: modelId, contextWindow, maxTokens });
    }
  });

  it.each([
    { name: "local-model", baseUrl: "http://127.0.0.1:11434", maxTokens: 8192 },
    { name: "minimax-m3", baseUrl: "http://127.0.0.1:11434", maxTokens: 8192 },
    { name: "kimi-k3", baseUrl: "http://127.0.0.1:11434", maxTokens: 8192 },
    { name: "minimax-m3", baseUrl: "https://ollama.com", maxTokens: 524_288 },
    { name: "kimi-k3", baseUrl: "https://ollama.com", maxTokens: 1_048_576 },
    { name: "glm-5.2:cloud", baseUrl: "http://127.0.0.1:11434", maxTokens: 131_072 },
    { name: "unknown:cloud", baseUrl: "http://127.0.0.1:11434", maxTokens: 262_144 },
    { name: "unknown", baseUrl: "https://ollama.com", maxTokens: 262_144 },
    {
      name: "remote-stub",
      baseUrl: "http://127.0.0.1:11434",
      remote_host: "https://ollama.com",
      maxTokens: 262_144,
    },
    {
      name: "remote-model-stub",
      baseUrl: "http://127.0.0.1:11434",
      remote_model: "upstream-model",
      maxTokens: 262_144,
    },
  ])(
    "discovers $name output limits at $baseUrl",
    async ({ name, baseUrl, remote_host, remote_model, maxTokens }) => {
      stubDiscovery([{ name, remote_host, remote_model }], {
        capabilities: completion,
        model_info: { "test.context_length": 262_144 },
      });
      expect((await discoverModel(baseUrl)).runtime).toMatchObject({ id: name, maxTokens });
    },
  );

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models = [{ name: "llama3-32k:latest" }];
    stubDiscovery(models, {
      model_info: { "llama.context_length": 8192 },
      parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
      capabilities: completion,
    });
    expect(await enrichOllamaModelsWithContext(localUrl, models)).toEqual([
      { name: "llama3-32k:latest", contextWindow: 32768, capabilities: completion },
    ]);
  });

  it("closes real failed discovery sockets while preserving successful discovery", async () => {
    const socketClosures = new Map<string, Promise<void>>();
    let mode: "failure" | "success" = "failure";

    const handleRequest: Parameters<typeof withServer>[0] = (request, response) => {
      const path = request.url;
      if (path !== "/api/tags" && path !== "/api/show") {
        response.writeHead(404);
        response.end();
        return;
      }

      if (mode === "failure") {
        socketClosures.set(
          path,
          new Promise<void>((resolve) => {
            request.socket.once("close", () => resolve());
          }),
        );
        response.writeHead(503, { "content-type": "text/plain" });
        // Leave the body open so only real client cancellation can close its socket.
        response.write("ollama unavailable");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      if (path === "/api/tags") {
        response.end(JSON.stringify({ models: [{ name: "llama3:8b" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          model_info: { "llama.context_length": 32768 },
          capabilities: ["completion", "tools"],
        }),
      );
    };

    const waitForSocketClose = async (path: string): Promise<void> => {
      const closed = socketClosures.get(path);
      if (!closed) {
        throw new Error(`No failed discovery socket was recorded for ${path}`);
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`Failed discovery socket was not closed for ${path}`));
            }, 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    };

    await withServer(handleRequest, async (baseUrl) => {
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [],
      });
      await waitForSocketClose("/api/tags");

      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        showInspectionFailed: true,
      });
      await waitForSocketClose("/api/show");

      mode = "success";
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [{ name: "llama3:8b" }],
      });
      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        contextWindow: 32768,
        capabilities: ["completion", "tools"],
      });
    });
  });

  it("preserves remote-model-only list capabilities after a live inspection failure", async () => {
    const listed = {
      name: "remote-chat:latest",
      remote_model: "upstream-chat:latest",
      digest: "sha256:remote-model-list-metadata",
      details: { context_length: 32_768 },
      capabilities: ["tools"],
    };

    await withServer(
      (request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/tags") {
          response.end(JSON.stringify({ models: [listed] }));
          return;
        }
        if (request.url === "/api/show") {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "show failed" }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      },
      async (baseUrl) => {
        expect((await discoverModel(baseUrl)).model).toMatchObject({
          id: listed.name,
          contextWindow: 32_768,
          compat: { supportsTools: true },
          reasoning: false,
        });
      },
    );
  });

  it.each(["tags", "show"] as const)(
    "bounds %s discovery JSON and cancels oversized streams",
    async (endpoint) => {
      // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels
      // the stream mid-flight; if the cap were removed the reader would buffer the whole payload.
      const ONE_MIB = 1024 * 1024;
      const TOTAL_CHUNKS = 32;
      const chunk = new Uint8Array(ONE_MIB);

      let bytesPulled = 0;
      let canceled = false;
      const makeOversizedJsonResponse = (): Response => {
        bytesPulled = 0;
        canceled = false;
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= TOTAL_CHUNKS) {
              controller.close();
              return;
            }
            pulled += 1;
            bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => makeOversizedJsonResponse()),
      );
      const result =
        endpoint === "tags"
          ? await fetchOllamaModels(localUrl)
          : await queryOllamaModelShowInfo(localUrl, "evil-model:latest");
      expect(result).toEqual(
        endpoint === "tags" ? { reachable: false, models: [] } : { showInspectionFailed: true },
      );
      expect(canceled).toBe(true);
      expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
    },
  );
});

describe("Ollama model discovery failures", () => {
  it.each([503, "offline", "invalid-json", "missing-models"])(
    "preserves advisory discovery while strict catalogs reject %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") {
            throw new Error("Ollama endpoint unavailable");
          }
          return new Response(failure === "invalid-json" ? "{" : "{}", {
            status: typeof failure === "number" ? failure : 200,
          });
        }),
      );

      await expect(buildOllamaProvider(localUrl, { quiet: true })).resolves.toMatchObject({
        models: [],
      });
      await expect(buildOllamaProvider(localUrl, { discoveryMode: "strict" })).rejects.toThrow();
    },
  );
});

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it.each([
    [localUrl, "127.0.0.1"],
    ["http://192.168.1.10:11434", "192.168.1.10"],
    ["https://ollama.example.com/v1", "ollama.example.com"],
  ])("pins requests to the configured HTTP(S) hostname %s", (url, hostname) => {
    expect(buildOllamaBaseUrlSsrFPolicy(url)).toEqual({
      hostnameAllowlist: [hostname],
      allowPrivateNetwork: true,
    });
  });

  it.each(["", "ftp://ollama.example.com", "not-a-url", "http://metadata.google.internal"])(
    "rejects empty, invalid or blocked base URL %s",
    (url) => {
      expect(buildOllamaBaseUrlSsrFPolicy(url)).toBeUndefined();
    },
  );
});
