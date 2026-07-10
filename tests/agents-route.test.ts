import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn(),
  clearConfigCache: vi.fn(),
  loadConfig: vi.fn((filePath) => YAML.load(fs.readFileSync(filePath, "utf-8"))),
}));

function expectAppEvent(emitEvent, type, payload) {
  expect(emitEvent).toHaveBeenCalledWith({
    type: "app_event",
    event: {
      type,
      payload,
      source: "server",
    },
  }, null);
}

describe("agents route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agents-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("emits agent-created after creating an agent", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      createAgent: vi.fn().mockResolvedValue({ id: "hana", name: "Hana" }),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hana" }),
    });

    expect(res.status).toBe(200);
    expectAppEvent(engine.emitEvent, "agent-created", { agentId: "hana", name: "Hana" });
  });

  it("does not emit agent-created when create validation fails", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      createAgent: vi.fn(),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: " " }),
    });

    expect(res.status).toBe(400);
    expect(engine.createAgent).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("rejects an explicit non-ASCII agent id before calling the engine", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      createAgent: vi.fn(),
      emitEvent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ming", id: "明" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("agent ID") });
    expect(engine.createAgent).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("preserves a safe legacy ASCII id containing uppercase letters and underscores", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      createAgent: vi.fn().mockResolvedValue({ id: "Legacy_AGENT-1", name: "Legacy" }),
      emitEvent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Legacy", id: "Legacy_AGENT-1" }),
    });

    expect(res.status).toBe(200);
    expect(engine.createAgent).toHaveBeenCalledWith({
      name: "Legacy",
      id: "Legacy_AGENT-1",
      yuan: undefined,
    });
  });

  it("rejects an invalid primary agent id before calling the engine", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      setPrimaryAgent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/primary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "中文助手" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("agent ID") });
    expect(engine.setPrimaryAgent).not.toHaveBeenCalled();
  });

  it("persists a valid primary agent id", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      setPrimaryAgent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/primary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "Legacy_AGENT-1" }),
    });

    expect(res.status).toBe(200);
    expect(engine.setPrimaryAgent).toHaveBeenCalledWith("Legacy_AGENT-1");
  });

  it.each([
    { label: "non-ASCII", order: ["hana", "中文助手"], error: "agent ID" },
    { label: "non-string", order: ["hana", 42], error: "agent ID" },
    { label: "unknown", order: ["hana", "missing"], error: "not found" },
    { label: "duplicate", order: ["hana", "hana"], error: "duplicate" },
  ])("rejects $label agent order without persisting it", async ({ order, error }) => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      getAgent: vi.fn((id) => id === "hana" ? { id } : null),
      saveAgentOrder: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(error) });
    expect(engine.saveAgentOrder).not.toHaveBeenCalled();
  });

  it("persists an order only after every agent id is valid, unique, and known", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const knownIds = new Set(["Legacy_AGENT-1", "hana"]);
    const engine = {
      getAgent: vi.fn((id) => knownIds.has(id) ? { id } : null),
      saveAgentOrder: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const order = ["Legacy_AGENT-1", "hana"];
    const res = await app.request("/api/agents/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });

    expect(res.status).toBe(200);
    expect(engine.getAgent).toHaveBeenCalledTimes(order.length);
    expect(engine.saveAgentOrder).toHaveBeenCalledWith(order);
  });

  it("invalidates the agent list cache when a fresh list is requested", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      gcWorkspacePersistence: vi.fn(),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => [{ id: "hana", name: "Hana", isCurrent: true }]),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents?fresh=1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.agents).toEqual([{ id: "hana", name: "Hana", isCurrent: true }]);
    expect(engine.invalidateAgentListCache).toHaveBeenCalledTimes(1);
    expect(engine.invalidateAgentListCache.mock.invocationCallOrder[0])
      .toBeLessThan(engine.listAgents.mock.invocationCallOrder[0]);
  });

  it("returns create validation status codes without emitting agent-created", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const err: any = new Error('Invalid yuan "caikangyong": template not found in lib/yuan');
    err.code = "INVALID_YUAN";
    err.statusCode = 400;
    const engine = {
      createAgent: vi.fn().mockRejectedValue(err),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "蔡康永", yuan: "caikangyong" }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('Invalid yuan "caikangyong"');
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("returns and emits the switched session workspace contract", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      currentAgentId: "target",
      config: { cwd_history: ["/old"] },
      switchAgent: vi.fn().mockResolvedValue({
        sessionPath: "/sessions/target.jsonl",
        cwd: "/workspace/target",
        homeFolder: "/workspace/target",
      }),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      getSessionWorkspaceFolders: vi.fn(() => ["/workspace/reference"]),
      getSessionAuthorizedFolders: vi.fn(() => ["/workspace/assets"]),
      getAgent: vi.fn(() => ({
        agentName: "Target",
        memoryMasterEnabled: false,
      })),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "target" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.updateConfig).toHaveBeenCalledWith({
      last_cwd: "/workspace/target",
      cwd_history: ["/workspace/target", "/old"],
    }, { agentId: "target" });
    expect(data).toMatchObject({
      ok: true,
      agent: { id: "target", name: "Target" },
      sessionPath: "/sessions/target.jsonl",
      cwd: "/workspace/target",
      homeFolder: "/workspace/target",
      workspaceFolders: ["/workspace/reference"],
      authorizedFolders: ["/workspace/assets"],
      cwdHistory: ["/workspace/target", "/old"],
      memoryMasterEnabled: false,
    });
    expectAppEvent(engine.emitEvent, "agent-switched", {
      agentId: "target",
      agentName: "Target",
      sessionPath: "/sessions/target.jsonl",
      cwd: "/workspace/target",
      homeFolder: "/workspace/target",
      workspaceFolders: ["/workspace/reference"],
      authorizedFolders: ["/workspace/assets"],
      cwdHistory: ["/workspace/target", "/old"],
      memoryMasterEnabled: false,
    });
  });

  it("emits models-changed for provider-only config updates before the early return", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "other",
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          openai: {
            api: "openai-completions",
            api_key: "sk-test",
            models: ["gpt-5"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expectAppEvent(engine.emitEvent, "models-changed", { agentId });
  });

  it("emits scoped config events after saving changed config blocks", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib"),
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      setLocale: vi.fn(),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      setMemoryMasterEnabled: vi.fn(),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "en-US",
        agent: { name: "Hana Prime", yuan: "butter" },
        desk: { home_folder: "/tmp/hana-work" },
        memory: { enabled: false },
        models: { chat: { id: "gpt-5", provider: "openai" } },
        skills: { enabled: ["writer"] },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      agent: { name: "Hana Prime", yuan: "butter" },
      desk: { home_folder: "/tmp/hana-work" },
      memory: expect.objectContaining({ enabled: false }),
      models: { chat: { id: "gpt-5", provider: "openai" } },
      skills: { enabled: ["writer"] },
    }), { agentId });
    expect(engine.setMemoryMasterEnabled).toHaveBeenCalledWith(agentId, false);
    expectAppEvent(engine.emitEvent, "models-changed", { agentId });
    expectAppEvent(engine.emitEvent, "agent-updated", {
      agentId,
      agentName: "Hana Prime",
      yuan: "butter",
    });
    expectAppEvent(engine.emitEvent, "agent-workspace-changed", {
      agentId,
      homeFolder: "/tmp/hana-work",
    });
    expectAppEvent(engine.emitEvent, "memory-master-changed", {
      agentId,
      enabled: false,
    });
    expectAppEvent(engine.emitEvent, "locale-changed", { locale: "en-US" });
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId });
  });

  it.each([
    { discover_project_skills: "true" },
    { discover_compatible_project_skills: 1 },
  ])("rejects non-boolean workspace skill policy fields: %j", async (workspaceContext) => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn(),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_context: workspaceContext }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("must be a boolean") });
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("does not mutate shared runtime selection when saving a non-focus Agent workspace policy", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "other-agent",
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncAgentWorkspaceSkills: vi.fn(),
      syncWorkspaceSkillPaths: vi.fn(),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      emitEvent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const patch = {
      workspace_context: {
        discover_project_skills: false,
        discover_compatible_project_skills: true,
      },
    };
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    expect(res.status).toBe(200);
    expect(engine.updateConfig).toHaveBeenCalledWith(patch, { agentId });
    expect(engine.syncAgentWorkspaceSkills).not.toHaveBeenCalled();
    expect(engine.syncWorkspaceSkillPaths).not.toHaveBeenCalled();
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId });
  });

  it("recomputes the focused Agent skill selection after saving workspace policy", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: { getAllProvidersRaw: vi.fn(() => ({})), get: vi.fn(() => null) },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncAgentWorkspaceSkills: vi.fn(),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      emitEvent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_context: { discover_project_skills: false } }),
    });

    expect(res.status).toBe(200);
    expect(engine.syncAgentWorkspaceSkills).toHaveBeenCalledWith(agentId);
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId });
  });

  it("editing another agent config can clear saved provider credentials", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "api:\n  provider: openai\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const saveProvider = vi.fn();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "other",
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid yuan updates before writing agent config", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n  yuan: hanako\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      productDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib"),
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { yuan: "pm-assistant" } }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('Invalid yuan "pm-assistant"');
    expect(fs.readFileSync(path.join(agentDir, "config.yaml"), "utf-8")).toContain("yuan: hanako");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("refreshes generated description after identity changes", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/identity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "新的公开身份材料" }),
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("新的公开身份材料");
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId, refreshDescription: true });
    expect(engine.invalidateAgentListCache).toHaveBeenCalledTimes(1);
    expectAppEvent(engine.emitEvent, "agent-updated", { agentId });
  });

  it("rejects dangerous experience headings without overwriting agent files", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\nexperience:\n  enabled: true\n", "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "original identity\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/experience`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "# ../identity\nmalicious overwrite\n",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid experience category" });
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("original identity\n");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });
});
