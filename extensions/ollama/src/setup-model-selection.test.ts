import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";
import {
  buildAppGuidedOllamaModel,
  discoverOllamaModelsForSetup,
  selectAppGuidedOllamaModelFromDiscovery,
} from "./setup-model-selection.js";
import { configureInteractive, startNonInteractive } from "./setup.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pendingAbortableResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

function modelShow(capabilities?: string[]) {
  return Response.json({ model_info: { "test.context_length": 32_768 }, capabilities });
}

describe("Ollama onboarding model selection", () => {
  it("retains freshly inspected size when using a configured cloud definition", () => {
    const model = buildAppGuidedOllamaModel({
      baseUrl: "http://127.0.0.1:11434",
      model: { name: "compact-chat:cloud" },
      showInfo: {
        contextWindow: 32_768,
        capabilities: ["completion", "tools"],
        parameterCount: 4_000_000_000,
      },
      configuredCloudModel: createModel("compact-chat:cloud", "Compact Chat", {
        contextWindow: 32_768,
      }),
    });
    expect(model?.parameterCount).toBe(4_000_000_000);
  });

  it("selects a deterministic tools-capable model with enough context", () => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        { name: "llama3:8b", contextWindow: 32_768, capabilities: ["tools"] },
        { name: "qwen3:0.6b", contextWindow: 40_960, capabilities: ["tools"] },
        { name: "gemma4:e4b", contextWindow: 8_192, capabilities: ["tools"] },
      ]),
    ).toBe("qwen3:0.6b");
  });

  it("selects the smallest explicitly non-thinking model during interactive setup", async () => {
    const { result } = await configureInteractive({
      fallbackResponse: (url) => {
        throw new Error(`Unexpected fetch: ${url}`);
      },
      tagModels: [
        { name: "deepseek-r1:1b", size: 100 },
        { name: "llama3:70b", size: 70_000 },
      ],
      showResponse: () => modelShow(["completion", "tools"]),
    });
    const selected = result.config.models?.providers?.ollama?.models?.find(
      (model) => model.id === "deepseek-r1:1b",
    );

    expect(selected?.reasoning).toBe(false);
    expect(result.defaultModel).toBe("ollama/deepseek-r1:1b");
  });

  it("selects and configures list-advertised models when model inspection fails", async () => {
    const { result, prompter } = await configureInteractive(
      {
        fallbackResponse: () => Response.json({ error: "inspection unavailable" }, { status: 503 }),
        tagModels: [
          {
            name: "gemma4:e2b",
            size: 2_000_000_000,
            details: { context_length: 32_768 },
            capabilities: ["completion", "tools"],
          },
        ],
        showResponse: () => Response.json({ error: "inspection unavailable" }, { status: 503 }),
      },
      { confirm: vi.fn().mockResolvedValue(false) },
    );

    expect(result.defaultModel).toBe("ollama/gemma4:e2b");
    expect(result.config.models?.providers?.ollama?.models).toContainEqual(
      expect.objectContaining({
        id: "gemma4:e2b",
        contextWindow: 32_768,
        compat: expect.objectContaining({ supportsTools: true }),
      }),
    );
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("preserves incomplete remote-model-only capabilities during interactive setup", async () => {
    const { result } = await configureInteractive(
      {
        fallbackResponse: () => Response.json({}),
        tagModels: [
          {
            name: "deepseek-r1:remote",
            remote_model: "upstream-deepseek-r1",
            size: 2_000_000_000,
            details: { context_length: 32_768 },
            capabilities: ["tools"],
          },
        ],
        showResponse: () => Response.json({}),
      },
      {
        select: vi.fn().mockResolvedValueOnce("cloud-local"),
        confirm: vi.fn().mockResolvedValue(false),
      },
    );

    expect(result.defaultModel).toBe("ollama/deepseek-r1:remote");
    expect(result.config.models?.providers?.ollama?.models).toContainEqual(
      expect.objectContaining({
        id: "deepseek-r1:remote",
        contextWindow: 32_768,
        reasoning: true,
        compat: expect.objectContaining({ supportsTools: true }),
      }),
    );
  });

  it.each([
    ["local-only", "completion"],
    ["cloud-local", "embedding"],
  ] as const)(
    "respects %s mode with %s remote rows before inspecting and configuring mixed inventory",
    async (mode, remoteCapability) => {
      const remoteModels = Array.from({ length: 201 }, (_, index) => ({
        name: index % 3 === 2 ? `remote-${index}:cloud` : `remote-${index}:latest`,
        ...(index % 3 === 0 ? { remote_host: "https://ollama.com" } : {}),
        ...(index % 3 === 1 ? { remote_model: `upstream-${index}` } : {}),
        size: 1,
      }));
      const inspected: string[] = [];
      const { result } = await configureInteractive(
        {
          fallbackResponse: () => Response.json({}),
          tagModels: [...remoteModels, { name: "local-chat:latest", size: 500 }],
          showResponse: (model) => {
            inspected.push(model);
            return modelShow([
              model.startsWith("remote-") ? remoteCapability : "completion",
              "tools",
            ]);
          },
        },
        {
          select: vi.fn().mockResolvedValueOnce(mode),
          confirm: vi.fn().mockResolvedValue(false),
        },
      );
      const configured = result.config.models?.providers?.ollama?.models.map((model) => model.id);

      if (mode === "local-only") {
        expect(inspected).toEqual(["local-chat:latest"]);
        expect(result.defaultModel).toBe("ollama/local-chat:latest");
        expect(configured).toContain("local-chat:latest");
        expect(configured?.filter((name) => name.startsWith("remote-"))).toEqual([]);
      } else {
        expect(inspected).toContain(remoteModels[0]?.name);
        expect(inspected).toContain("local-chat:latest");
        expect(result.defaultModel).toBe("ollama/local-chat:latest");
        expect(configured?.filter((name) => name.startsWith("remote-"))).toEqual([]);
      }
    },
  );

  it("respects completion and embedding capabilities when selecting and configuring a default", async () => {
    const remoteName = "remote-model:latest";
    const localName = "local-chat:latest";
    const { configure } = startNonInteractive({
      tagModels: [
        {
          name: remoteName,
          remote_model: "upstream-model",
          size: 1,
          capabilities: ["completion", "embedding"],
          details: { parameter_size: "4B" },
        },
        { name: localName, size: 500 },
      ],
      showResponse: (model) =>
        modelShow(model === remoteName ? undefined : ["completion", "tools"]),
      fallbackResponse: () => Response.json({}),
    });
    const config = await configure();
    expect(config.agents?.defaults?.model).toEqual({ primary: `ollama/${remoteName}` });
    const configured = config.models?.providers?.ollama?.models;
    expect(configured).toContainEqual(expect.objectContaining({ id: localName, maxTokens: 8192 }));
    const remote = configured?.find((model) => model.id === remoteName);
    expect(remote).toMatchObject({
      id: remoteName,
      maxTokens: 32_768,
      compat: { supportsTools: true },
    });
    expect(remote).not.toHaveProperty("parameterCount");
  });

  it("aborts pending context enrichment with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "gemma4" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return pendingAbortableResponse(init?.signal);
      }),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });
});
