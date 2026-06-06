// plugins/image-gen/index.js
import path from "node:path";
import fs from "node:fs";
import { AdapterRegistry } from "./lib/adapter-registry.ts";
import { TaskStore } from "./lib/task-store.ts";
import { Poller } from "./lib/poller.ts";
import { volcengineImageAdapter } from "./adapters/volcengine.ts";
import { openaiImageAdapter } from "./adapters/openai.ts";
import { openaiCodexImageAdapter } from "./adapters/openai-codex.ts";
import { minimaxImageAdapter } from "./adapters/minimax.ts";
import { dashscopeImageAdapter } from "./adapters/dashscope.ts";
import { geminiImageAdapter } from "./adapters/gemini.ts";
import { submitImageGeneration } from "./lib/submit-image.ts";

export default class ImageGenPlugin {
  declare ctx: any;
  declare register: any;
  async onload() {
    const { dataDir, bus, log } = this.ctx;

    const generatedDir = path.join(dataDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });

    // Infrastructure
    const registry = new AdapterRegistry();
    const store = new TaskStore(dataDir);
    const poller = new Poller({
      store,
      registry,
      bus,
      dataDir,
      generatedDir,
      log,
      registerSessionFile: this.ctx.registerSessionFile,
    });

    // Built-in adapters
    registry.register(volcengineImageAdapter);
    registry.register(openaiImageAdapter);
    registry.register(openaiCodexImageAdapter);
    registry.register(minimaxImageAdapter);
    registry.register(dashscopeImageAdapter);
    registry.register(geminiImageAdapter);

    // Attach to ctx for tools
    this.ctx._mediaGen = { registry, store, poller, generatedDir };

    // Bus handlers — adapter registration (for external plugins like dreamina)
    this.register(bus.handle("media-gen:register-adapter", ({ adapter }) => {
      registry.register(adapter);
      log.info(`adapter registered: ${adapter.id}`);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:unregister-adapter", ({ adapterId }) => {
      registry.unregister(adapterId);
      log.info(`adapter unregistered: ${adapterId}`);
      return { ok: true };
    }));

    // Listen for fire-and-forget unregister events (plugin teardown is sync)
    this.register(bus.subscribe((event) => {
      if (event.type === "media-gen:adapter-removed" && event.adapterId) {
        registry.unregister(event.adapterId);
        log.info(`adapter removed (event): ${event.adapterId}`);
      }
    }));

    this.register(bus.handle("media-gen:list-adapters", () => {
      return { adapters: registry.list().map((a) => ({ id: a.id, name: a.name, types: a.types })) };
    }));

    this.register(bus.handle("media-gen:submit-image", async ( payload: any = {}) => {
      const input = payload.input && typeof payload.input === "object" ? payload.input : payload;
      const sessionPath = typeof payload.sessionPath === "string" && payload.sessionPath.trim()
        ? payload.sessionPath.trim()
        : null;
      if (!sessionPath) return { ok: false, error: "sessionPath is required" };
      try {
        return await submitImageGeneration({
          input,
          ctx: {
            ...this.ctx,
            sessionPath,
            _mediaGen: this.ctx._mediaGen,
          },
          metadata: payload.metadata || null,
          deliveryTarget: payload.deliveryTarget === undefined ? null : payload.deliveryTarget,
        } as any);
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }));

    // Bus handlers — task CRUD (for external panels like dreamina)
    this.register(bus.handle("media-gen:get-tasks", ({ adapterId, batchId, status }: any = {}) => {
      let tasks = store.listAll();
      if (adapterId) tasks = tasks.filter((t) => t.adapterId === adapterId);
      if (batchId) tasks = tasks.filter((t) => t.batchId === batchId);
      if (status) tasks = tasks.filter((t) => t.status === status);
      return { tasks };
    }));

    this.register(bus.handle("media-gen:get-task", ({ taskId }) => {
      return { task: store.get(taskId) };
    }));

    this.register(bus.handle("media-gen:update-task", ({ taskId, fields }) => {
      const allowed: any = {};
      if (typeof fields?.favorited === "boolean") allowed.favorited = fields.favorited;
      store.update(taskId, allowed);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-task", ({ taskId }) => {
      const task = store.get(taskId);
      if (task) {
        for (const f of task.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
        store.remove(taskId);
      }
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-unfavorited", () => {
      const removed = store.removeUnfavorited();
      for (const t of removed) {
        for (const f of t.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
      }
      return { ok: true, removed: removed.length };
    }));

    // Start poller
    poller.start();

    // Register media-generation task handler for TaskRegistry
    bus.request("task:register-handler", {
      type: "media-generation",
      abort: (taskId) => { poller.cancel(taskId); },
    }).catch(() => {});

    // Cleanup
    this.register(() => {
      poller.stop();
      store.destroy();
      bus.request("task:unregister-handler", { type: "media-generation" }).catch(() => {});
      log.info("image-gen plugin unloaded");
    });

    log.info("image-gen plugin loaded (unified media-gen)");
  }
}
