import { describe, expect, it, vi } from "vitest";
import { Hub } from "../hub/index.ts";
import JimengCliPlugin from "../plugins/jimeng-cli/index.ts";

function createEngine(providerRegistry, mediaConfig: any = {}) {
  return {
    agentsDir: "/agents",
    channelsDir: null,
    hanakoHome: "/tmp/hana",
    providerRegistry,
    media: {
      getImageConfig: vi.fn(() => mediaConfig.image || {}),
      getVideoConfig: vi.fn(() => mediaConfig.video || {}),
    },
    setHubCallbacks: vi.fn(),
    setEventBus: vi.fn(),
    getAgent: vi.fn(() => null),
    updateConfig: vi.fn(async () => {}),
    listAgents: vi.fn(() => []),
    listSessions: vi.fn(async () => []),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    executeExternalMessage: vi.fn(async () => {}),
    executeIsolated: vi.fn(async () => {}),
  } as any;
}

function createProviderRegistry() {
  return {
    get: vi.fn((providerId) => providerId === "jimeng-cli"
      ? { source: { kind: "plugin", pluginId: "jimeng-cli" } }
      : null),
    getCredentials: vi.fn(() => ({})),
    getModelsByType: vi.fn(() => []),
    getAllModelsByType: vi.fn(() => []),
    getRuntimeMediaCapabilitySourceOwner: vi.fn(() => null),
    registerRuntimeMediaCapabilitySource: vi.fn(),
    unregisterRuntimeMediaCapabilitySource: vi.fn(),
    refreshRuntimeMediaCapabilities: vi.fn(async () => ({
      "jimeng-cli": { status: "ready", version: "2.0.0" },
    })),
    getMediaProviders: vi.fn(() => [{
      providerId: "jimeng-cli",
      displayName: "即梦 CLI",
      authType: "none",
      source: { kind: "plugin", pluginId: "jimeng-cli" },
      runtime: null,
      credentialLanes: [],
      runtimeCapability: { status: "ready", version: "2.0.0" },
      models: [{ id: "jimeng-image-5.0", protocolId: "jimeng-cli-images" }],
    }]),
    getMediaProviderCredentialStatus: vi.fn(() => ({
      hasCredentials: true,
      unavailableReason: null,
      lanes: [],
    })),
  };
}

describe("Jimeng runtime provider capability integration", () => {
  it("registers one shared discovery source with both media adapters for the plugin lifetime", async () => {
    const cleanups: Array<() => void> = [];
    const request = vi.fn(async (type: string, _payload?: any) => {
      if (type === "provider:register-runtime-media-capability-source") return { ok: true };
      if (type === "media-gen:register-adapter") return { ok: true };
      return { ok: true };
    });
    const plugin = new JimengCliPlugin() as any;
    plugin.ctx = {
      bus: { request },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    plugin.register = (cleanup: () => void) => cleanups.push(cleanup);

    await plugin.onload();

    const sourceCall = request.mock.calls.find(([type]) => type === "provider:register-runtime-media-capability-source");
    expect(sourceCall?.[1]).toMatchObject({
      providerId: "jimeng-cli",
      source: { refresh: expect.any(Function) },
    });
    const adapterCalls = request.mock.calls.filter(([type]) => type === "media-gen:register-adapter");
    expect(adapterCalls.map((call) => call[1]?.adapter.id)).toEqual([
      "jimeng-cli-images",
      "jimeng-cli-videos",
    ]);
    expect(cleanups).toHaveLength(3);

    for (const cleanup of cleanups) cleanup();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("provider:unregister-runtime-media-capability-source", {
      providerId: "jimeng-cli",
    });
    expect(request).toHaveBeenCalledWith("media-gen:unregister-adapter", {
      adapterId: "jimeng-cli-images",
    });
    expect(request).toHaveBeenCalledWith("media-gen:unregister-adapter", {
      adapterId: "jimeng-cli-videos",
    });
  });

  it("refreshes runtime capabilities before returning Provider model choices", async () => {
    const providerRegistry = createProviderRegistry();
    const hub = new Hub({
      engine: createEngine(providerRegistry, {
        image: { defaultImageModel: { provider: "private-default-provider", id: "private-default-model" } },
      }),
    });

    const imageResult = await hub.eventBus.request("provider:media-providers", {
      capability: "image_generation",
    });

    expect(providerRegistry.refreshRuntimeMediaCapabilities).toHaveBeenCalledWith({
      capability: "image_generation",
    });
    expect(imageResult.providers["jimeng-cli"]).toMatchObject({
      runtimeCapability: { status: "ready", version: "2.0.0" },
      models: [expect.objectContaining({ id: "jimeng-image-5.0" })],
    });
    expect(imageResult.selection).toMatchObject({
      defaultConfigured: true,
      selectionPolicy: "configured_default",
      overrideRequired: false,
      defaultInvocation: { provider: "omit", model: "omit" },
    });
    expect(JSON.stringify(imageResult.selection)).not.toContain("private-default-provider");
    expect(JSON.stringify(imageResult.selection)).not.toContain("private-default-model");

    const videoResult = await hub.eventBus.request("provider:media-providers", {
      capability: "video_generation",
    });
    expect(videoResult.selection).toMatchObject({
      defaultConfigured: false,
      selectionPolicy: "first_available_fallback",
      overrideRequired: false,
      defaultInvocation: { provider: "omit", model: "omit" },
    });
    expect(providerRegistry.refreshRuntimeMediaCapabilities.mock.invocationCallOrder[0])
      .toBeLessThan(providerRegistry.getMediaProviders.mock.invocationCallOrder[0]);
  });

  it("lets a provider plugin register and clean up only its own discovery source", async () => {
    const providerRegistry = createProviderRegistry();
    const hub = new Hub({ engine: createEngine(providerRegistry) });
    const source = { refresh: vi.fn(async () => ({ media: {} })) };
    const caller = { kind: "plugin", pluginId: "jimeng-cli" };

    await expect(hub.eventBus.request(
      "provider:register-runtime-media-capability-source",
      { providerId: "jimeng-cli", source },
      { caller },
    )).resolves.toEqual({ ok: true });
    expect(providerRegistry.registerRuntimeMediaCapabilitySource).toHaveBeenCalledWith(
      "jimeng-cli",
      source,
      { pluginId: "jimeng-cli" },
    );

    await expect(hub.eventBus.request(
      "provider:unregister-runtime-media-capability-source",
      { providerId: "jimeng-cli" },
      { caller },
    )).resolves.toEqual({ ok: true });
    expect(providerRegistry.unregisterRuntimeMediaCapabilitySource).toHaveBeenCalledWith(
      "jimeng-cli",
      { pluginId: "jimeng-cli" },
    );
  });

  it("rejects a plugin trying to replace another provider's discovery source", async () => {
    const providerRegistry = createProviderRegistry();
    const hub = new Hub({ engine: createEngine(providerRegistry) });

    await expect(hub.eventBus.request(
      "provider:register-runtime-media-capability-source",
      { providerId: "jimeng-cli", source: { refresh: vi.fn() } },
      { caller: { kind: "plugin", pluginId: "unrelated-plugin" } },
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot manage"),
    });
    expect(providerRegistry.registerRuntimeMediaCapabilitySource).not.toHaveBeenCalled();
  });
});
