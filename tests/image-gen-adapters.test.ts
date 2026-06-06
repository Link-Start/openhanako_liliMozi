import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// saveImage writes to disk — mock it out so tests stay pure
vi.mock("../plugins/image-gen/lib/download.ts", () => ({
  saveImage: vi.fn(async (_buf, _mime, _dir, customName) => {
    const filename = customName ? `${customName}-abc.png` : `1234-abc.png`;
    return { filename, filePath: `/tmp/generated/${filename}` };
  }),
}));

function makeBusCtx(apiKey, baseUrl, providerId = "volcengine") {
  return {
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:credentials" && payload.providerId === providerId) {
          return { apiKey, baseUrl };
        }
        return { error: "not_found" };
      }),
    },
    config: {
      get: vi.fn((key) => {
        if (key === "providerDefaults") return {};
        return null;
      }),
    },
    dataDir: "/tmp/test-data",
    log: vi.fn(),
  };
}

function makeCodexJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("volcengine adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("does not send Seedream 5-only output_format to Seedream 4.0", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ b64_json: fakeB64, size: "2048x2048" }],
      }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    const result = await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "doubao-seedream-4-0-250828",
      size: "2K",
      format: "png",
    }, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("doubao-seedream-4-0-250828");
    expect(body.prompt).toBe("a cat");
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("2K");
    expect(body).not.toHaveProperty("output_format");

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
    expect(result.taskId.length).toBeGreaterThan(0);
  });

  it("sends output_format only for Seedream 5 models", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "doubao-seedream-5-0-lite-260128",
      format: "png",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.output_format).toBe("png");
  });

  it("maps generic 1k resolution to the nearest Seedream size tier", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "doubao-seedream-4-0-250828",
      ratio: "1:1",
      resolution: "1k",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe("2048x2048");
  });

  it("applies Seedream 3-only providerDefaults without leaking them to newer models", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { volcengine: { watermark: true, guidance_scale: 7.5, seed: 42 } };
      return null;
    });

    await volcengineImageAdapter.submit({
      prompt: "test",
      model: "doubao-seedream-3-0-t2i",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.watermark).toBe(true);
    expect(body.guidance_scale).toBe(7.5);
    expect(body.seed).toBe(42);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    await volcengineImageAdapter.submit({
      prompt: "test",
      model: "doubao-seedream-4-0-250828",
    }, ctx);

    const seedream4Body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(seedream4Body.watermark).toBe(true);
    expect(seedream4Body).not.toHaveProperty("guidance_scale");
    expect(seedream4Body).not.toHaveProperty("seed");
  });

  it("throws on API error with status and message", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "invalid key" } }),
    });

    const ctx = makeBusCtx("bad", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "a cat", model: "test",
    }, ctx)).rejects.toThrow(/401/);
  });

  it("throws when data array is empty", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow();
  });

  it("accepts Volcengine Coding Plan credentials in the same auth path used by submit", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.ts");

    const request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "volcengine") {
        return { error: "no_credentials" };
      }
      if (type === "provider:credentials" && payload.providerId === "volcengine-coding") {
        return {
          apiKey: "coding-plan-key",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
          api: "openai-completions",
        };
      }
      return { error: "not_found" };
    });

    const result = await volcengineImageAdapter.checkAuth({
      bus: { request },
    });

    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("provider:credentials", { providerId: "volcengine" });
    expect(request).toHaveBeenCalledWith("provider:credentials", { providerId: "volcengine-coding" });
  });
});

describe("openai adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends correct request and returns files from b64_json", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    const fakeB64 = Buffer.from("fake-openai-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ b64_json: fakeB64, revised_prompt: "A fluffy dog in a park" }],
      }),
    });

    const ctx = makeBusCtx("sk-test", "https://api.openai.com/v1", "openai");
    const result = await openaiImageAdapter.submit({
      prompt: "a dog",
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "medium",
      format: "png",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-image-1");
    expect(body.prompt).toBe("a dog");
    expect(body.quality).toBe("medium");
    expect(body.n).toBe(1);

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
  });

  it("uses official OpenAI image default model when no model is provided", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    await openaiImageAdapter.submit({ prompt: "test" }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-image-1.5");
  });

  it("maps generic 4k resolution to gpt-image-2 size", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    await openaiImageAdapter.submit({
      prompt: "a notebook on a quiet desk",
      model: "gpt-image-2",
      ratio: "16:9",
      resolution: "4K",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe("3840x2160");
    expect(body).not.toHaveProperty("resolution");
    expect(body).not.toHaveProperty("ratio");
  });

  it("uses JSON images references for OpenAI URL edits", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    const fakeB64 = Buffer.from("edited").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    await openaiImageAdapter.submit({
      prompt: "make it warmer",
      model: "gpt-image-1.5",
      image: "https://example.com/input.png",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body).not.toHaveProperty("image");
    expect(body.images).toEqual([{ image_url: "https://example.com/input.png" }]);
  });

  it("applies providerDefaults (background)", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { openai: { background: "transparent" } };
      return null;
    });

    await openaiImageAdapter.submit({
      prompt: "test",
      model: "gpt-image-1",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.background).toBe("transparent");
  });

  it("throws on API error", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.ts");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limit exceeded" } }),
    });

    const ctx = makeBusCtx("key", "https://test.com", "openai");
    await expect(openaiImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow(/429/);
  });
});

describe("openai codex oauth adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("uses Codex OAuth credentials and saves image_generation_call results", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const fakeB64 = Buffer.from("fake-codex-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          { type: "message", content: [{ type: "output_text", text: "done" }] },
          { type: "image_generation_call", result: fakeB64 },
        ],
      }),
    });

    const ctx = makeBusCtx("oauth-token", "https://chatgpt.com/backend-api", "openai-codex-oauth");
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "openai-codex-oauth") {
        return {
          apiKey: "oauth-token",
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          accountId: "acct_123",
        };
      }
      return { error: "not_found" };
    });

    const result = await openaiCodexImageAdapter.submit({
      prompt: "a quiet notebook on a wooden desk",
      model: "gpt-image-2",
      ratio: "1:1",
      quality: "high",
      format: "png",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(opts.headers.Authorization).toBe("Bearer oauth-token");
    expect(opts.headers["chatgpt-account-id"]).toBe("acct_123");
    expect(opts.headers["OpenAI-Beta"]).toBe("responses=experimental");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-5.5");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.input[0].content[0]).toEqual({
      type: "input_text",
      text: "a quiet notebook on a wooden desk",
    });
    expect(body.tools[0]).toMatchObject({
      type: "image_generation",
      size: "1024x1024",
      quality: "high",
      output_format: "png",
    });
    expect(body.tools[0]).not.toHaveProperty("ratio");
    expect(body.tools[0]).not.toHaveProperty("resolution");
    expect(body.tools[0]).not.toHaveProperty("aspect_ratio");

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
  });

  it("derives the Codex account id from the OAuth token when credentials omit it", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const fakeB64 = Buffer.from("fake-codex-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: "image_generation_call", result: fakeB64 }],
      }),
    });

    const ctx = makeBusCtx(
      makeCodexJwt("acct_from_token"),
      "https://chatgpt.com/backend-api",
      "openai-codex-oauth",
    );

    await openaiCodexImageAdapter.submit({
      prompt: "test",
    }, ctx);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["chatgpt-account-id"]).toBe("acct_from_token");
  });

  it("parses Codex streaming image_generation_call results", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const fakeB64 = Buffer.from("fake-codex-stream-image").toString("base64");
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "response.output_item.done",
            item: { type: "image_generation_call", result: fakeB64 },
          })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    });

    const ctx = makeBusCtx("oauth-token", "https://chatgpt.com/backend-api", "openai-codex-oauth");
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "openai-codex-oauth") {
        return {
          apiKey: "oauth-token",
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          accountId: "acct_123",
        };
      }
      return { error: "not_found" };
    });

    const result = await openaiCodexImageAdapter.submit({
      prompt: "a quiet notebook",
      format: "png",
    }, ctx);

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).stream).toBe(true);
    expect(result.files).toHaveLength(1);
  });

  it("requires a decodable Codex account id for ChatGPT backend requests", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const ctx = makeBusCtx("oauth-token", "https://chatgpt.com/backend-api", "openai-codex-oauth");

    await expect(openaiCodexImageAdapter.submit({
      prompt: "test",
    }, ctx)).rejects.toThrow(/account/i);
  });

  it("maps generic 4k resolution to the nearest Codex image tool size", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const fakeB64 = Buffer.from("fake-codex-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: "image_generation_call", result: fakeB64 }],
      }),
    });

    const ctx = makeBusCtx("oauth-token", "https://chatgpt.com/backend-api", "openai-codex-oauth");
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "openai-codex-oauth") {
        return {
          apiKey: "oauth-token",
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          accountId: "acct_123",
        };
      }
      return { error: "not_found" };
    });

    await openaiCodexImageAdapter.submit({
      prompt: "a quiet notebook",
      ratio: "16:9",
      resolution: "4K",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools[0]).toMatchObject({
      type: "image_generation",
      size: "3840x2160",
    });
    expect(body.tools[0]).not.toHaveProperty("resolution");
    expect(body.tools[0]).not.toHaveProperty("ratio");
  });

  it("accepts generic Codex size tiers but still rejects impossible pixel sizes", async () => {
    const { openaiCodexImageAdapter } = await import("../plugins/image-gen/adapters/openai-codex.ts");

    const fakeB64 = Buffer.from("fake-codex-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: "image_generation_call", result: fakeB64 }],
      }),
    });

    const ctx = makeBusCtx("oauth-token", "https://chatgpt.com/backend-api", "openai-codex-oauth");
    ctx.bus.request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "openai-codex-oauth") {
        return {
          apiKey: "oauth-token",
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          accountId: "acct_123",
        };
      }
      return { error: "not_found" };
    });

    await openaiCodexImageAdapter.submit({
      prompt: "a quiet notebook",
      size: "2K",
    }, ctx);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).tools[0].size).toBe("2048x2048");

    mockFetch.mockReset();
    await expect(openaiCodexImageAdapter.submit({
      prompt: "a quiet notebook",
      size: "4096x4096",
    }, ctx)).rejects.toThrow(/Codex.*size/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("minimax adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("calls MiniMax image_generation and saves base64 images", async () => {
    const { minimaxImageAdapter } = await import("../plugins/image-gen/adapters/minimax.ts");

    const fakeB64 = Buffer.from("minimax-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { image_base64: [fakeB64] },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    });

    const ctx = makeBusCtx("minimax-key", "https://api.minimaxi.com/anthropic", "minimax");
    const result = await minimaxImageAdapter.submit({
      prompt: "a glass teapot",
      modelId: "image-01",
      ratio: "16:9",
      providerId: "minimax",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(opts.headers.Authorization).toBe("Bearer minimax-key");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      model: "image-01",
      prompt: "a glass teapot",
      aspect_ratio: "16:9",
      response_format: "base64",
    });
    expect(result.files).toHaveLength(1);
  });

  it("rejects MiniMax image resolution instead of silently dropping it", async () => {
    const { minimaxImageAdapter } = await import("../plugins/image-gen/adapters/minimax.ts");

    const ctx = makeBusCtx("minimax-key", "https://api.minimaxi.com/v1", "minimax");
    await expect(minimaxImageAdapter.submit({
      prompt: "a quiet library",
      resolution: "4k",
      providerId: "minimax",
    }, ctx)).rejects.toThrow(/MiniMax.*resolution/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("gemini image adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("calls Gemini generateContent and saves inlineData images", async () => {
    const { geminiImageAdapter } = await import("../plugins/image-gen/adapters/gemini.ts");

    const fakeB64 = Buffer.from("gemini-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: fakeB64 } }],
          },
        }],
      }),
    });

    const ctx = makeBusCtx("gemini-key", "https://generativelanguage.googleapis.com/v1beta", "gemini");
    const result = await geminiImageAdapter.submit({
      prompt: "a quiet library",
      modelId: "gemini-3.1-flash-image-preview",
      ratio: "4:3",
      size: "2K",
      providerId: "gemini",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent");
    expect(opts.headers["x-goog-api-key"]).toBe("gemini-key");
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts[0].text).toBe("a quiet library");
    expect(body.generationConfig.responseFormat.image).toEqual({
      aspectRatio: "4:3",
      imageSize: "2K",
    });
    expect(body.generationConfig.responseFormat.image).not.toHaveProperty("ratio");
    expect(body.generationConfig.responseFormat.image).not.toHaveProperty("resolution");
    expect(body.generationConfig.responseFormat.image).not.toHaveProperty("size");
    expect(result.files).toHaveLength(1);
  });

  it("downloads ordinary image URLs and sends Gemini reference images as inline data", async () => {
    const { geminiImageAdapter } = await import("../plugins/image-gen/adapters/gemini.ts");

    const fakeB64 = Buffer.from("gemini-image").toString("base64");
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => Buffer.from("input-image"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: fakeB64 } }],
            },
          }],
        }),
      });

    const ctx = makeBusCtx("gemini-key", "https://generativelanguage.googleapis.com/v1beta", "gemini");
    await geminiImageAdapter.submit({
      prompt: "use this pose",
      modelId: "gemini-3.1-flash-image-preview",
      image: "https://example.com/ref.png",
      providerId: "gemini",
    }, ctx);

    expect(mockFetch.mock.calls[0][0]).toBe("https://example.com/ref.png");
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.contents[0].parts[1]).toEqual({
      inline_data: {
        mime_type: "image/png",
        data: Buffer.from("input-image").toString("base64"),
      },
    });
  });

  it("rejects unsupported Gemini image sizes instead of raw passthrough", async () => {
    const { geminiImageAdapter } = await import("../plugins/image-gen/adapters/gemini.ts");

    const fakeB64 = Buffer.from("gemini-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: fakeB64 } }],
          },
        }],
      }),
    });

    const ctx = makeBusCtx("gemini-key", "https://generativelanguage.googleapis.com/v1beta", "gemini");
    await expect(geminiImageAdapter.submit({
      prompt: "a quiet library",
      modelId: "gemini-3.1-flash-image-preview",
      size: "1024x1024",
      providerId: "gemini",
    }, ctx)).rejects.toThrow(/Gemini.*size/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("dashscope image adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("submits async Wan image tasks and queries result URLs", async () => {
    const { dashscopeImageAdapter } = await import("../plugins/image-gen/adapters/dashscope.ts");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: { task_id: "dash-task-1", task_status: "PENDING" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_status: "SUCCEEDED",
            choices: [{
              message: { content: [{ image: "https://dashscope-result.example/image.png" }] },
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => Buffer.from("dashscope-image"),
      });

    const ctx = makeBusCtx("dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope");
    const submitted = await dashscopeImageAdapter.submit({
      prompt: "a flower shop",
      modelId: "wan2.7-image-pro",
      resolution: "4k",
      providerId: "dashscope",
    }, ctx);

    expect(submitted).toEqual({ taskId: "dash-task-1" });
    expect(mockFetch.mock.calls[0][0]).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
    expect(mockFetch.mock.calls[0][1].headers["X-DashScope-Async"]).toBe("enable");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parameters.size).toBe("4K");

    const queried = await dashscopeImageAdapter.query("dash-task-1", ctx);
    expect(mockFetch.mock.calls[1][0]).toBe("https://dashscope.aliyuncs.com/api/v1/tasks/dash-task-1");
    expect(queried.status).toBe("done");
    expect(queried.files).toHaveLength(1);
  });

  it("saves DashScope async base64 image results instead of treating them as URLs", async () => {
    const { dashscopeImageAdapter } = await import("../plugins/image-gen/adapters/dashscope.ts");
    const fakeB64 = Buffer.from("dashscope-base64-image").toString("base64");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: {
          task_status: "SUCCEEDED",
          results: [{ b64_json: fakeB64 }],
        },
      }),
    });

    const ctx = makeBusCtx("dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope");
    const queried = await dashscopeImageAdapter.query("dash-task-base64", ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(queried.status).toBe("done");
    expect(queried.files).toEqual(["1234-abc.png"]);
  });

  it("submits Qwen 2 image models through the DashScope multimodal endpoint", async () => {
    const { dashscopeImageAdapter } = await import("../plugins/image-gen/adapters/dashscope.ts");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            choices: [{
              message: { content: [{ image: "https://dashscope-result.example/qwen.png" }] },
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => Buffer.from("qwen-image"),
      });

    const ctx = makeBusCtx("dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope");
    const submitted = await dashscopeImageAdapter.submit({
      prompt: "a bilingual poster",
      modelId: "qwen-image-2.0-pro",
      size: "2048*2048",
      providerId: "dashscope",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(opts.headers).not.toHaveProperty("X-DashScope-Async");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("qwen-image-2.0-pro");
    expect(body.input.messages[0].content).toEqual([{ text: "a bilingual poster" }]);
    expect(submitted.files).toHaveLength(1);
  });

  it("submits Qwen async text-to-image models with input.prompt", async () => {
    const { dashscopeImageAdapter } = await import("../plugins/image-gen/adapters/dashscope.ts");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: { task_id: "qwen-task-1", task_status: "PENDING" },
      }),
    });

    const ctx = makeBusCtx("dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope");
    const submitted = await dashscopeImageAdapter.submit({
      prompt: "a product poster",
      modelId: "qwen-image-plus",
      size: "1664*928",
      providerId: "dashscope",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis");
    expect(opts.headers["X-DashScope-Async"]).toBe("enable");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      model: "qwen-image-plus",
      input: { prompt: "a product poster" },
      parameters: { size: "1664*928", n: 1 },
    });
    expect(submitted).toEqual({ taskId: "qwen-task-1" });
  });
});
