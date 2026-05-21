import { describe, it, expect, vi } from "vitest";
import { createPluginContext } from "../core/plugin-context.js";

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("createPluginContext", () => {
  it("returns ctx with all required properties", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "test-plugin",
      pluginDir: "/plugins/test-plugin",
      dataDir: "/plugin-data/test-plugin",
      bus,
    });
    expect(ctx.pluginId).toBe("test-plugin");
    expect(ctx.pluginDir).toBe("/plugins/test-plugin");
    expect(ctx.dataDir).toBe("/plugin-data/test-plugin");
    expect(ctx.bus).toBeDefined();
    expect(typeof ctx.bus.emit).toBe("function");
    expect(ctx.log).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.set).toBe("function");
  });

  it("exposes server runtime scope when provided", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "scoped-plugin",
      pluginDir: "/plugins/scoped-plugin",
      dataDir: "/plugin-data/scoped-plugin",
      bus,
      runtimeContext: {
        serverId: "server_scope",
        serverNodeId: "node_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_node_scope_studio_scope",
          kind: "local_process",
          serverNodeId: "node_scope",
          studioId: "studio_scope",
        },
      },
    });

    expect(ctx.serverId).toBe("server_scope");
    expect(ctx.serverNodeId).toBe("node_scope");
    expect(ctx.userId).toBe("user_scope");
    expect(ctx.studioId).toBe("studio_scope");
    expect(ctx.connectionKind).toBe("local");
    expect(ctx.credentialKind).toBe("loopback_token");
    expect(ctx.platformAccountId).toBeNull();
    expect(ctx.officialServiceKind).toBeNull();
    expect(ctx.executionBoundary).toMatchObject({
      boundaryId: "execb_node_scope_studio_scope",
      serverNodeId: "node_scope",
      studioId: "studio_scope",
    });
  });

  it("registers plugin session files with resource content links when runtime scope is available", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const registerSessionFile = vi.fn((entry) => ({
      id: "sf_plugin_output",
      ...entry,
      ext: "png",
      mime: "image/png",
      kind: "image",
      status: "available",
    }));
    const ctx = createPluginContext({
      pluginId: "image-gen",
      pluginDir: "/plugins/image-gen",
      dataDir: "/plugin-data/image-gen",
      bus,
      registerSessionFile,
      runtimeContext: {
        serverId: "server_scope",
        serverNodeId: "node_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        connectionKind: "local",
        credentialKind: "loopback_token",
      },
    });

    const file = ctx.registerSessionFile({
      sessionPath: "/sessions/a.jsonl",
      filePath: "/plugin-data/image-gen/generated.png",
      label: "generated.png",
    });

    expect(file.resource).toMatchObject({
      resourceId: "res_sf_plugin_output",
      studioId: "studio_scope",
      links: {
        self: "/api/resources/res_sf_plugin_output",
        content: "/api/resources/res_sf_plugin_output/content",
      },
    });
  });

  it("config.get/set reads and writes plugin-data config.json", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = path.join(os.tmpdir(), "hana-ctx-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const ctx = createPluginContext({
        pluginId: "x", pluginDir: "/tmp", dataDir: tmpDir,
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      });
      ctx.config.set("foo", 42);
      expect(ctx.config.get("foo")).toBe(42);
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
      expect(raw.global.foo).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("log has scoped prefix", () => {
    const ctx = createPluginContext({
      pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
    });
    expect(typeof ctx.log.info).toBe("function");
    expect(typeof ctx.log.error).toBe("function");
  });

  it("forwards log entries to an optional log sink", () => {
    const logSink = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = createPluginContext({
        pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
        logSink,
      });
      ctx.log.info("hello", { token: "secret-token", count: 2 });
      expect(logSink).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: "my-plug",
        level: "info",
        args: ["hello", { token: "secret-token", count: 2 }],
      }));
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("createPluginContext with accessLevel", () => {
  it("full-access context exposes bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "full-access",
    });
    expect(typeof ctx.bus.handle).toBe("function");
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.listCapabilities).toBe("function");
    expect(typeof ctx.bus.getCapability).toBe("function");
  });

  it("restricted context does NOT expose bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(ctx.bus.handle).toBeUndefined();
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.subscribe).toBe("function");
    expect(typeof ctx.bus.listCapabilities).toBe("function");
    expect(typeof ctx.bus.getCapability).toBe("function");
  });

  it("restricted bus proxy is frozen", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(Object.isFrozen(ctx.bus)).toBe(true);
    expect(() => { ctx.bus.handle = () => {}; }).toThrow();
  });

  it("defaults to restricted when accessLevel omitted", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus,
    });
    expect(ctx.bus.handle).toBeUndefined();
  });
});
