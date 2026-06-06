import { describe, it, expect, vi, beforeEach } from "vitest";

// generate-image no longer imports adapter modules directly — adapters come
// through ctx._mediaGen.registry.  We import the tool fresh each time so
// module-level state doesn't leak between tests.

let execute, name, description, parameters;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../plugins/image-gen/tools/generate-image.ts");
  execute = mod.execute;
  name = mod.name;
  description = mod.description;
  parameters = mod.parameters;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter( overrides: any = {}) {
  return {
    id: "fake-provider",
    types: ["image"],
    checkAuth: vi.fn(async () => ({ ok: true })),
    submit: vi.fn(async () => ({ taskId: "task-001" })),
    ...overrides,
  };
}

function makeMediaGen( adapterOverrides: any = {}) {
  const adapter = makeAdapter(adapterOverrides);
  const registry = {
    get: vi.fn((id) => (id === adapter.id ? adapter : undefined)),
    getProtocol: vi.fn(() => null),
    getDefault: vi.fn((_type) => adapter),
    getByType: vi.fn((_type) => [adapter]),
  };
  const store = {
    add: vi.fn(),
    update: vi.fn(),
  };
  const poller = {
    add: vi.fn(),
  };
  return { registry, store, poller, adapter };
}

function makeCtx(mediaGen, busOverrides: any = {}) {
  return {
    _mediaGen: mediaGen,
    dataDir: "/tmp/test-data",
    sessionPath: "/sessions/test.jsonl",
    bus: {
      request: vi.fn(async () => ({})),
      ...busOverrides,
    },
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

async function flushBackgroundSubmits() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generate-image tool — metadata", () => {
  it("exports correct name and required param", () => {
    expect(name).toBe("generate-image");
    expect(description).toBeTruthy();
    expect(parameters.required).toContain("prompt");
  });
});

describe("generate-image tool — initialization guard", () => {
  it("returns error text when ctx._mediaGen is missing", async () => {
    const ctx = makeCtx(null);
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("未初始化");
  });

  it("returns error text when registry is missing from _mediaGen", async () => {
    const ctx = makeCtx({ store: {}, poller: {} });
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("未初始化");
  });

  it("requires an explicit sessionPath before starting a background task", async () => {
    const mediaGen = makeMediaGen();
    const ctx = { ...makeCtx(mediaGen), sessionPath: null };

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(result.content[0].text).toContain("缺少 sessionPath");
    expect(mediaGen.store.add).not.toHaveBeenCalled();
  });
});

describe("generate-image tool — adapter resolution", () => {
  it("returns error when no adapter of that type exists", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.getByType.mockReturnValue([]);
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("没有可用的图片生成 provider");
  });

  it("returns error when explicit provider not found", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.get.mockReturnValue(undefined);
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat", provider: "nonexistent" }, ctx);
    expect(result.content[0].text).toContain('指定的图片生成 provider "nonexistent" 不可用');
    expect(store.add).not.toHaveBeenCalled();
  });

  it("uses explicit provider via registry.get when provider is specified", async () => {
    const { registry, store, poller, adapter } = makeMediaGen();
    registry.get.mockImplementation((id) => (id === "fake-provider" ? adapter : undefined));
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a cat", provider: "fake-provider" }, ctx);
    expect(registry.get).toHaveBeenCalledWith("fake-provider");
  });

  it("does not fall back to another provider when explicit media provider resolution fails", async () => {
    const requestedAdapter = makeAdapter({
      id: "minimax",
      submit: vi.fn(async () => ({ taskId: "task-minimax" })),
    });
    const defaultAdapter = makeAdapter({
      id: "openai",
      submit: vi.fn(async () => ({ taskId: "task-openai" })),
    });
    const registry = {
      get: vi.fn((id) => (id === "minimax" ? requestedAdapter : defaultAdapter)),
      getProtocol: vi.fn(() => null),
      getByType: vi.fn(() => [defaultAdapter]),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn() };
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type) => {
        if (type === "provider:resolve-media-model") return { error: "no_credentials" };
        return {};
      }),
    });

    const result = await execute({ prompt: "a cat", provider: "minimax", model: "image-01" }, ctx);

    expect(result.content[0].text).toContain('指定的图片生成 provider "minimax" 不可用');
    expect(requestedAdapter.submit).not.toHaveBeenCalled();
    expect(defaultAdapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it("does not fall back to an arbitrary provider when an explicit model cannot be resolved", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "task-openai" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              openai: {
                providerId: "openai",
                models: [{ id: "gpt-image-1.5", protocolId: "openai-images" }],
                hasCredentials: true,
              },
            },
          };
        }
        return {};
      }),
    });

    const result = await execute({ prompt: "a cat", model: "image-01" }, ctx);

    expect(result.content[0].text).toContain('指定的图片生成模型 "image-01" 不可用');
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it("does not fall back to Codex when the configured default image model has no protocolId", async () => {
    const codexAdapter = makeAdapter({
      id: "openai-codex-oauth",
      submit: vi.fn(async () => ({ taskId: "task-codex" })),
    });
    const registry = {
      get: vi.fn(() => null),
      getProtocol: vi.fn(() => null),
      getByType: vi.fn(() => [codexAdapter]),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn() };
    const ctx = {
      ...makeCtx({ registry, store, poller }, {
        request: vi.fn(async (type) => {
          if (type === "provider:resolve-media-model") {
            return { providerId: "axis", modelId: "gpt-image-2" };
          }
          return {};
        }),
      }),
      config: {
        get: vi.fn((key) => key === "defaultImageModel" ? { provider: "axis", id: "gpt-image-2" } : undefined),
      },
    };

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(result.content[0].text).toContain('指定的图片生成 provider "axis" 不可用');
    expect(result.content[0].text).toContain('media model "axis/gpt-image-2" missing protocolId');
    expect(codexAdapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it("does not fall back when the configured default image model protocol has no adapter", async () => {
    const codexAdapter = makeAdapter({
      id: "openai-codex-oauth",
      submit: vi.fn(async () => ({ taskId: "task-codex" })),
    });
    const registry = {
      get: vi.fn(() => null),
      getProtocol: vi.fn(() => null),
      getByType: vi.fn(() => [codexAdapter]),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn() };
    const ctx = {
      ...makeCtx({ registry, store, poller }, {
        request: vi.fn(async (type) => {
          if (type === "provider:resolve-media-model") {
            return { providerId: "axis", modelId: "gpt-image-2", protocolId: "axis-images" };
          }
          return {};
        }),
      }),
      config: {
        get: vi.fn((key) => key === "defaultImageModel" ? { provider: "axis", id: "gpt-image-2" } : undefined),
      },
    };

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(result.content[0].text).toContain("没有注册协议 axis-images");
    expect(codexAdapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it("uses a custom provider's credentials when its image model is bound to the OpenAI images protocol", async () => {
    const openaiAdapter = makeAdapter({
      id: "openai",
      protocolId: "openai-images",
      submit: vi.fn(async () => ({ taskId: "task-axis" })),
    });
    const registry = {
      get: vi.fn(() => null),
      getProtocol: vi.fn((protocolId) => protocolId === "openai-images" ? openaiAdapter : null),
      getByType: vi.fn(() => []),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn() };
    const ctx = {
      ...makeCtx({ registry, store, poller }, {
        request: vi.fn(async (type) => {
          if (type === "provider:resolve-media-model") {
            return {
              providerId: "axis",
              modelId: "gpt-image-2",
              protocolId: "openai-images",
              credentialProviderId: "axis",
            };
          }
          return {};
        }),
      }),
      config: {
        get: vi.fn((key) => key === "defaultImageModel" ? { provider: "axis", id: "gpt-image-2" } : undefined),
      },
    };

    await execute({ prompt: "a cat" }, ctx);

    expect(openaiAdapter.submit).toHaveBeenCalledOnce();
    expect(openaiAdapter.submit.mock.calls[0][0]).toMatchObject({
      providerId: "axis",
      modelId: "gpt-image-2",
      model: "gpt-image-2",
      protocolId: "openai-images",
      credentialProviderId: "axis",
    });
    expect(store.add.mock.calls[0][0]).toMatchObject({
      adapterId: "openai",
      providerId: "axis",
      modelId: "gpt-image-2",
      protocolId: "openai-images",
    });
  });

  it("uses last registered adapter when no provider specified", async () => {
    const { registry, store, poller } = makeMediaGen();
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a cat" }, ctx);
    expect(registry.getByType).toHaveBeenCalledWith("image");
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("falls back to the newest credentialed image adapter when a later adapter is unavailable", async () => {
    const openaiAdapter = makeAdapter({
      id: "openai",
      submit: vi.fn(async () => ({ taskId: "task-openai", files: ["img.png"] })),
    });
    const codexAdapter = makeAdapter({
      id: "openai-codex-oauth",
      checkAuth: vi.fn(async () => ({ ok: false, message: "no_credentials" })),
      submit: vi.fn(async () => {
        throw new Error("Provider \"openai-codex-oauth\" 未登录。");
      }),
    });
    const registry = {
      get: vi.fn(),
      getDefault: vi.fn(),
      getByType: vi.fn(() => [openaiAdapter, codexAdapter]),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn() };
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a desk lamp" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(openaiAdapter.submit).toHaveBeenCalledOnce();
    expect(codexAdapter.submit).not.toHaveBeenCalled();
    expect(result.details.mediaGeneration.tasks).toEqual([{ taskId }]);
  });
});

describe("generate-image tool — submit error", () => {
  it("returns a placeholder and marks the task failed when background submit throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("CLI not found"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;
    expect(result.content[0].text).toContain("已提交 1 张");

    await flushBackgroundSubmits();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        status: "failed",
        failReason: "CLI not found",
        submitState: "failed",
      }),
    );
  });
});

describe("generate-image tool — single submit returns media placeholder metadata", () => {
  it("returns a pending media placeholder before adapter.submit settles", async () => {
    let resolveSubmit;
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(() => new Promise((resolve) => {
        resolveSubmit = resolve;
      })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const resultPromise = execute({ prompt: "a slow moon" }, ctx);
    const returnedImmediately = await Promise.race([
      resultPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ]);

    expect(returnedImmediately).toBe(true);
    const result = await resultPromise;
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(result.details.mediaGeneration.tasks).toEqual([{ taskId }]);
    expect(poller.add).toHaveBeenCalledWith(taskId);
    expect(store.update).not.toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ files: ["generated.png"] }),
    );

    resolveSubmit({ taskId: "remote-task-1", files: ["generated.png"] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        adapterTaskId: "remote-task-1",
        files: ["generated.png"],
        submitState: "submitted",
      }),
    );
  });

  it("returns mediaGeneration metadata on successful single submit", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-abc" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a sunset" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(result.content[0].text).toContain("已提交 1 张");
    expect(result.details.card).toBeUndefined();
    expect(result.details.mediaGeneration).toMatchObject({
      kind: "image",
      prompt: "a sunset",
      tasks: [{ taskId }],
    });
    expect(result.details.mediaGeneration.batchId).toBeTruthy();
  });

  it("records task in store", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-store" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "mountains" }, ctx);

    expect(store.add).toHaveBeenCalledOnce();
    const call = store.add.mock.calls[0][0];
    expect(call.taskId).toBeTruthy();
    expect(call.type).toBe("image");
    expect(call.prompt).toBe("mountains");
    expect(call.adapterTaskId).toBeNull();
    expect(call.submitState).toBe("submitting");
  });

  it("registers task with deferred:register", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred" })),
    });
    const busRequest = vi.fn(async () => ({}));
    const ctx = makeCtx({ registry, store, poller }, { request: busRequest });

    await execute({ prompt: "ocean" }, ctx);

    const deferredCall = (busRequest.mock.calls as any).find(([type]: any) => type === "deferred:register");
    const taskId = store.add.mock.calls[0][0].taskId;
    expect(deferredCall).toBeTruthy();
    expect(deferredCall![1].taskId).toBe(taskId);
    expect(deferredCall![1].meta.type).toBe("image-generation");
    expect(deferredCall![1].meta.mediaKind).toBe("image");
    expect(deferredCall![1].meta.deliveryIntent).toBe("ui_only");
    expect(deferredCall![1].meta.triggerParentTurn).toBe(false);
    expect(deferredCall![1].meta.notifyAgentOnFailure).toBe(true);
  });

  it("marks bridge-originated tasks for bridge delivery instead of desktop parent delivery", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-bridge-deferred" })),
    });
    const busRequest = vi.fn(async () => ({}));
    const ctx = {
      ...makeCtx({ registry, store, poller }, { request: busRequest }),
      bridgeContext: {
        isBridgeSession: true,
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hanako",
        agentId: "hanako",
        chatType: "dm",
      },
    };

    await execute({ prompt: "ocean" }, ctx);

    const deferredCall = (busRequest.mock.calls as any).find(([type]: any) => type === "deferred:register");
    expect(deferredCall![1].meta.deliveryTarget).toEqual({
      kind: "bridge",
      platform: "wechat",
      chatId: "wx-user",
      sessionKey: "wx_dm_wx-user@hanako",
      agentId: "hanako",
      chatType: "dm",
    });
  });

  it("adds task to poller", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-poll" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "forest" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(poller.add).toHaveBeenCalledWith(taskId);
  });

  it("updates the local task when background submit returns files", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-files", files: ["img.png"] })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a bird" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;
    await flushBackgroundSubmits();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        adapterTaskId: "t-files",
        files: ["img.png"],
        submitState: "submitted",
      }),
    );
  });
});

describe("generate-image tool — count=3 concurrent submits", () => {
  it("submits count times and records all tasks", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "stars", count: 3 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(3);
    expect(poller.add).toHaveBeenCalledTimes(3);
    expect(result.content[0].text).toContain("已提交 3 张");
  });

  it("clamps count to max 9", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "clouds", count: 10 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(9);
  });

  it("clamps count to min 1", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-min" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "waves", count: 0 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(1);
  });

  it("all tasks share the same batchId", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-batch-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "desert", count: 2 }, ctx);

    const batchIds = store.add.mock.calls.map(([arg]) => arg.batchId);
    expect(batchIds[0]).toBe(batchIds[1]);
    expect(batchIds[0]).toBeTruthy();
  });
});

describe("generate-image tool — partial failure handling", () => {
  it("returns placeholders for all requested images and records per-task background failures", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        if (callIndex === 2) throw new Error("network error");
        return { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "rain", count: 3 }, ctx);
    expect(result.content[0].text).toContain("已提交 3 张");
    expect(result.details.mediaGeneration.tasks).toHaveLength(3);

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(1);
    expect(failedUpdates[0][1].failReason).toBe("network error");
  });

  it("returns placeholders even when every background submit later fails", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("quota exceeded"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "snow", count: 2 }, ctx);
    expect(result.content[0].text).toContain("已提交 2 张");
    expect(result.details.mediaGeneration.tasks).toHaveLength(2);

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(2);
    expect(failedUpdates[0][1].failReason).toBe("quota exceeded");
  });

  it("marks a background submit with no provider taskId or files as failed", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        // second call returns no taskId
        return callIndex === 2 ? {} : { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "ice", count: 2 }, ctx);
    expect(result.content[0].text).toContain("已提交 2 张");

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(1);
    expect(failedUpdates[0][1].failReason).toContain("没有返回 taskId 或文件");
  });
});

describe("generate-image tool — image param (image-to-image)", () => {
  it("passes image param to adapter.submit", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-img2img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "enhance", image: "/path/to/ref.png" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.image).toBe("/path/to/ref.png");
  });

  it("omits image key from params when not provided", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-no-img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "landscape" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams).not.toHaveProperty("image");
  });
});

describe("generate-image tool — deferred:register failure is non-fatal", () => {
  it("still returns media placeholder metadata when deferred:register throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred-fail" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type) => {
        if (type === "deferred:register") throw new Error("bus unavailable");
        return {};
      }),
    });

    const result = await execute({ prompt: "fire" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(result.content[0].text).toContain("已提交 1 张");
    expect(result.details.mediaGeneration.tasks).toEqual([{ taskId }]);
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});
