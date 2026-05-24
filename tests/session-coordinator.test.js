import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerListMock, emitSessionShutdownMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerListMock: vi.fn(),
  emitSessionShutdownMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: emitSessionShutdownMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    list: sessionManagerListMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";
import { VisionBridge, VISION_CONTEXT_START } from "../core/vision-bridge.js";

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    sessionManagerListMock.mockResolvedValue([]);
    emitSessionShutdownMock.mockResolvedValue(false);
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies session memory before creating the agent session", async () => {
    let sessionMemoryEnabled = true;
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      buildSystemPrompt: () => sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
    };

    const resourceLoader = {
      getSystemPrompt: () => (sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF"),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("injects restored vision sidecar notes without reading stale Pi context getters", async () => {
    const sessionFile = path.join(tempDir, "vision-restore.jsonl");
    const imagePath = path.join(tempDir, "upload.png");
    const textOnlyModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };
    const callText = vi.fn(async () => [
      "image_overview: A screenshot with a red error banner.",
      "user_request_answer: The error banner is the relevant visual detail.",
      "evidence: red banner.",
      "uncertainty: none.",
    ].join("\n"));
    const visionBridge = new VisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
    });
    await visionBridge.prepare({
      sessionPath: sessionFile,
      targetModel: textOnlyModel,
      text: `[attached_image: ${imagePath}]\nwhat is this?`,
      images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
      imageAttachmentPaths: [imagePath],
    });
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => visionBridge,
        getSessionFile: vi.fn(),
        getSessionFileByPath: vi.fn(),
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    const extension = resourceLoader.getExtensions().extensions
      .find((entry) => entry.path === "hana-desktop-vision-context-injection");
    const handler = extension.handlers.get("context")[0];
    const staleCtx = {
      get sessionManager() {
        throw new Error("stale session manager");
      },
      get model() {
        throw new Error("stale model");
      },
    };

    const result = await handler({
      messages: [{
        role: "user",
        content: [{ type: "text", text: `[attached_image: ${imagePath}]\nwhat is this?` }],
      }],
    }, staleCtx);

    expect(result.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[0].content[0].text).toContain("image_overview");
  });

  it("passes desktop steer text to the SDK without adding an internal prefix", () => {
    const sessionPath = path.join(tempDir, "steer.jsonl");
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => null,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      lastTouchedAt: 0,
      visibleInSessionList: true,
    });

    expect(coordinator.steerSession(sessionPath, "先别展开，直接给结论")).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("先别展开，直接给结论");
  });

  it("lists sessions from a lightweight projection without delegating to the Pi SDK full scan", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    const sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "projection.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        id: "projection",
        timestamp: "2026-05-17T08:00:00.000Z",
        cwd: "/tmp/projection-workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-05-17T08:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello projection" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-05-17T08:02:00.000Z",
        message: {
          role: "assistant",
          content: "hello back",
        },
      }),
      "",
    ].join("\n"));
    fs.writeFileSync(
      path.join(sessionDir, "session-titles.json"),
      JSON.stringify({ [sessionFile]: "Cached title" }, null, 2),
    );
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(sessionFile)]: {
          pinnedAt: "2026-05-17T08:03:00.000Z",
          model: { id: "gpt-test", provider: "openai" },
        },
      }, null, 2),
    );

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ agentName: "Hana", sessionDir }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    const first = await coordinator.listSessions();
    const second = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      path: sessionFile,
      title: "Cached title",
      firstMessage: "hello projection",
      messageCount: 2,
      cwd: "/tmp/projection-workspace",
      agentId: "hana",
      agentName: "Hana",
      pinnedAt: "2026-05-17T08:03:00.000Z",
      modelId: "gpt-test",
      modelProvider: "openai",
    });
    expect(first[0].modified.toISOString()).toBe("2026-05-17T08:02:00.000Z");
    expect(second).toEqual(first);
  });

  it("refreshes only the changed session projection when one JSONL file changes", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "changing.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "changing", timestamp: "2026-05-17T08:00:00.000Z", cwd: "/tmp/work" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-05-17T08:01:00.000Z", message: { role: "user", content: "first" } }),
      "",
    ].join("\n"));

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ agentName: "Hana", sessionDir }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    expect((await coordinator.listSessions())[0].messageCount).toBe(1);
    fs.appendFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-05-17T08:02:00.000Z",
        message: { role: "assistant", content: "second" },
      }) + "\n",
    );

    const sessions = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].modified.toISOString()).toBe("2026-05-17T08:02:00.000Z");
  });

  it("lists user-created pending sessions before their JSONL projection exists", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "pending.jsonl");
    const sessionManager = {
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionPath,
    };
    const model = { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat" };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
      config: {},
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager,
        model,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    await coordinator.createSession(null, "/tmp/workspace", true, null, {
      visibleInSessionList: true,
    });

    const sessions = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: sessionPath,
      title: null,
      firstMessage: "",
      messageCount: 0,
      cwd: "/tmp/workspace",
      agentId: "hana",
      agentName: "Hana",
      modelId: "deepseek-chat",
      modelProvider: "deepseek",
      pinnedAt: null,
    });
  });

  it("treats auxiliary vision preparation as streaming before provider prompt starts", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "vision-pending.jsonl");
    const sessionManager = {
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionPath,
    };
    const model = {
      id: "deepseek-vision",
      provider: "deepseek",
      name: "DeepSeek Vision",
      input: ["image"],
    };
    const session = {
      sessionManager,
      model,
      isStreaming: false,
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
      config: {},
    };
    let releasePrepare;
    const prepareStarted = new Promise((resolve) => {
      releasePrepare = resolve;
    });
    let finishPrepare;
    const prepareCanFinish = new Promise((resolve) => {
      finishPrepare = resolve;
    });
    const visionBridge = {
      prepare: vi.fn(async () => {
        releasePrepare();
        await prepareCanFinish;
        return { text: "prepared image context", images: [] };
      }),
    };

    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => visionBridge,
        log: { warn: vi.fn() },
      }),
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });
    await coordinator.createSession(null, "/tmp/workspace", true, null, {
      visibleInSessionList: true,
    });

    const promptPromise = coordinator.promptSession(sessionPath, "describe image", {
      images: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
    });
    await prepareStarted;

    const streamingDuringPrepare = coordinator.isSessionStreaming(sessionPath);
    const listedDuringPrepare = (await coordinator.listSessions()).some((s) => s.path === sessionPath);

    finishPrepare();
    await promptPromise;
    expect(streamingDuringPrepare).toBe(true);
    expect(listedDuringPrepare).toBe(true);
    expect(session.prompt).toHaveBeenCalledWith("prepared image context", undefined);
  });

  it("builds session tools with sandbox workspace pinned to the effective cwd", async () => {
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "write" }],
    };
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const sessionCwd = path.join(tempDir, "session-cwd");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true);

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: sessionCwd,
      }),
    );
  });

  it("passes the frozen experience state into the agent tool snapshot", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "experience.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      getToolsSnapshot: vi.fn(() => []),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: vi.fn(() => ({ tools: [], customTools: [] })),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      forceExperienceEnabled: false,
      model: { name: "test-model" },
    });
  });

  it("keeps legacy create_artifact out of fresh sessions but restores it for old sessions", async () => {
    const freshSessionFile = path.join(tempDir, "agents", "hana", "sessions", "fresh.jsonl");
    const restoredSessionFile = path.join(tempDir, "agents", "hana", "sessions", "restored.jsonl");
    const restoredNewSessionFile = path.join(tempDir, "agents", "hana", "sessions", "restored-new.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      getToolsSnapshot: vi.fn((options = {}) => [
        { name: "stage_files" },
        ...(options.includeLegacyArtifactTool ? [{ name: "create_artifact" }] : []),
      ]),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => freshSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => restoredSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => restoredNewSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    await coordinator.createSession(null, tempDir, true, null, { restore: true });
    fs.writeFileSync(
      path.join(agent.sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(restoredNewSessionFile)]: { toolNames: ["stage_files"] } }, null, 2),
    );
    await coordinator.createSession(
      { getCwd: () => tempDir, getSessionFile: () => restoredNewSessionFile },
      tempDir,
      true,
      null,
      { restore: true },
    );

    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual(["stage_files"]);
    expect(buildTools.mock.calls[1][1].map((tool) => tool.name)).toEqual([
      "stage_files",
      "create_artifact",
    ]);
    expect(buildTools.mock.calls[2][1].map((tool) => tool.name)).toEqual(["stage_files"]);
    expect(agent.getToolsSnapshot.mock.calls[0][0]).not.toHaveProperty("includeLegacyArtifactTool", true);
    expect(agent.getToolsSnapshot.mock.calls[1][0]).toMatchObject({
      includeLegacyArtifactTool: true,
    });
    expect(agent.getToolsSnapshot.mock.calls[2][0]).not.toHaveProperty("includeLegacyArtifactTool", true);
  });

  it("threads extra workspace folders into tools, prompt context, and session meta", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "scope.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "read" }],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const sessionCwd = path.join(tempDir, "main-workspace");
    const extra = path.join(tempDir, "reference");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => sessionCwd,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true, null, {
      workspaceFolders: [extra, sessionCwd, extra],
    });

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        workspace: sessionCwd,
        workspaceFolders: [extra],
      }),
    );
    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("额外文件夹");
    expect(appendPrompt.join("\n")).toContain(extra);

    const meta = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].workspaceFolders).toEqual([extra]);
    expect(coordinator.getSessionWorkspaceFolders(sessionFile)).toEqual([extra]);
  });

  it("freezes the DeepSeek prompt patch when the session is created with a DeepSeek reasoning model", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "deepseek.jsonl");
    const deepseekModel = {
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
      name: "DeepSeek V4 Pro",
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: deepseekModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: deepseekModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("如果你使用的是 DeepSeek 模型");
    expect(appendPrompt.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("restores the original prompt snapshot instead of rebuilding from current agent state", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "frozen-prompt.jsonl");
    let currentAgentPrompt = "SYSTEM PROMPT V1";
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => currentAgentPrompt),
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const freshSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT V1",
      agent: { state: { systemPrompt: "FINAL PROMPT V1" } },
    };
    const restoredSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(function () {
        this._baseSystemPrompt = "FINAL PROMPT CURRENT";
        this.agent.state.systemPrompt = "FINAL PROMPT CURRENT";
      }),
      _baseSystemPrompt: "FINAL PROMPT CURRENT",
      agent: { state: { systemPrompt: "FINAL PROMPT CURRENT" } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: freshSession })
      .mockResolvedValueOnce({ session: restoredSession });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "claude-opus-4-5", provider: "anthropic", name: "Claude" },
        availableModels: [{ id: "claude-opus-4-5", provider: "anthropic", name: "Claude" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND V1"],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [{ name: "skill-v1" }], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    currentAgentPrompt = "SYSTEM PROMPT V2";
    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
        buildSessionContext: () => ({ model: { provider: "anthropic", modelId: "claude-opus-4-5" } }),
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    const restoreOptions = createAgentSessionMock.mock.calls[1][0];
    expect(restoreOptions.resourceLoader.getSystemPrompt()).toBe("SYSTEM PROMPT V1");
    const restoredAppend = restoreOptions.resourceLoader.getAppendSystemPrompt().join("\n");
    expect(restoredAppend).toContain("BASE APPEND V1");
    expect(restoredAppend).not.toContain("BASE APPEND V2");
    expect(restoreOptions.resourceLoader.getSkills()).toEqual({ skills: [{ name: "skill-v1" }], diagnostics: [] });
    expect(restoreOptions.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [{ path: "/AGENTS.md", content: "rules v1" }] });
    expect(restoredSession._baseSystemPrompt).toBe("FINAL PROMPT V1");
    expect(restoredSession.agent.state.systemPrompt).toBe("FINAL PROMPT V1");
    expect(agent.buildSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("restores a prompt-snapshotted session with xhigh before the SDK model is available", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "xhigh-restore.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "CURRENT BASE"),
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(agent.sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(sessionFile)]: {
          thinkingLevel: "xhigh",
          promptSnapshot: {
            version: 1,
            systemPrompt: "FROZEN BASE",
            appendSystemPrompt: [],
            skillsResult: { skills: [], diagnostics: [] },
            agentsFilesResult: { agentsFiles: [] },
          },
        },
      }),
    );
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
        availableModels: [{ id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "xhigh" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].thinkingLevel).toBe("high");
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("FROZEN BASE");
  });

  it("stores skill pointers for a session and omits restored skills whose source was deleted", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "skill-snapshot.jsonl");
    const skillDir = path.join(tempDir, "skills", "stable-skill");
    fs.mkdirSync(path.join(skillDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: stable-skill\ndescription: Stable skill.\n---\n\noriginal body\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(skillDir, "assets", "note.txt"), "asset v1\n", "utf-8");

    const skill = {
      name: "stable-skill",
      description: "Stable skill.",
      filePath: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "user",
      sourceInfo: {
        path: path.join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        source: "local",
      },
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const freshSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT WITH SKILL",
      agent: { state: { systemPrompt: "FINAL PROMPT WITH SKILL" } },
    };
    const restoredSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT CURRENT",
      agent: { state: { systemPrompt: "FINAL PROMPT CURRENT" } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: freshSession })
      .mockResolvedValueOnce({ session: restoredSession });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "claude-opus-4-5", provider: "anthropic", name: "Claude" },
        availableModels: [{ id: "claude-opus-4-5", provider: "anthropic", name: "Claude" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => ({
        getSkillsForAgent: () => ({ skills: [skill], diagnostics: [] }),
      }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const sessionMgr = {
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
      buildSessionContext: () => ({ model: { provider: "anthropic", modelId: "claude-opus-4-5" } }),
    };

    await coordinator.createSession(sessionMgr, tempDir, true);
    const freshSkill = createAgentSessionMock.mock.calls[0][0].resourceLoader.getSkills().skills[0];
    expect(freshSkill.filePath).toBe(skill.filePath);
    expect(freshSkill.runtimeIdentity).toMatchObject({
      kind: "skill_pointer",
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      readonly: true,
    });
    expect(fs.readFileSync(freshSkill.filePath, "utf-8")).toContain("original body");
    expect(fs.readFileSync(path.join(freshSkill.baseDir, "assets", "note.txt"), "utf-8")).toBe("asset v1\n");

    fs.rmSync(skillDir, { recursive: true, force: true });

    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });
    const restoredSkills = createAgentSessionMock.mock.calls[1][0].resourceLoader.getSkills();
    expect(restoredSkills.skills).toEqual([]);
    expect(restoredSkills.diagnostics).toEqual([
      expect.objectContaining({
        type: "warning",
        message: 'skill "stable-skill" source is no longer available',
        path: skill.filePath,
      }),
    ]);
  });

  it("restores frozen append prompts so provider prompt patches survive cold restore", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "deepseek-restore.jsonl");
    const deepseekModel = {
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
      name: "DeepSeek V4 Pro",
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          _baseSystemPrompt: "FINAL DEEPSEEK",
          agent: { state: { systemPrompt: "FINAL DEEPSEEK" } },
          model: deepseekModel,
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          _baseSystemPrompt: "FINAL CURRENT",
          agent: { state: { systemPrompt: "FINAL CURRENT" } },
          model: deepseekModel,
        },
      });
    let baseAppend = ["BASE APPEND V1"];

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: deepseekModel,
        availableModels: [deepseekModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => baseAppend,
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    baseAppend = ["BASE APPEND V2"];
    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
        buildSessionContext: () => ({ model: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" } }),
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    const appendPrompt = createAgentSessionMock.mock.calls[1][0].resourceLoader.getAppendSystemPrompt().join("\n");
    expect(appendPrompt).toContain("BASE APPEND V1");
    expect(appendPrompt).toContain("DeepSeek 输出契约");
    expect(appendPrompt).not.toContain("BASE APPEND V2");
  });

  it("does not add the DeepSeek prompt patch when a non-DeepSeek session later switches models", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "non-deepseek.jsonl");
    const qwenModel = { id: "qwen3.6-max-preview", provider: "dashscope", reasoning: true };
    const deepseekModel = { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true };
    let currentModel = qwenModel;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      model: qwenModel,
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    currentModel = deepseekModel;
    session.model = deepseekModel;

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).not.toContain("DeepSeek 输出契约");
  });

  it("blocks image prompts for text-only models when auxiliary vision is disabled", async () => {
    const sessionFile = path.join(tempDir, "text-only-images.jsonl");
    const sessionPrompt = vi.fn();
    const prepare = vi.fn(async () => ({
      text: "vision notes",
      images: [],
    }));
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => false,
        getVisionBridge: () => ({ prepare }),
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    })).rejects.toThrow(/vision auxiliary is disabled/);
    expect(prepare).not.toHaveBeenCalled();
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("blocks video prompts unless the model explicitly declares video input", async () => {
    const sessionFile = path.join(tempDir, "text-only-video.jsonl");
    const sessionPrompt = vi.fn();
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      videos: [{ type: "video", data: "abc", mimeType: "video/mp4" }],
    })).rejects.toThrow(/current model does not support video input/);
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("blocks video prompts when the provider transport cannot carry video", async () => {
    const sessionFile = path.join(tempDir, "kimi-coding-video.jsonl");
    const sessionPrompt = vi.fn();
    const kimiCodingModel = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "anthropic-messages",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: kimiCodingModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: kimiCodingModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      videos: [{ type: "video", data: "abc", mimeType: "video/mp4" }],
    })).rejects.toThrow(/current provider does not support direct video input/);
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("fresh session freezes the effective memory state into meta for cache safety", async () => {
    const sessionFile = path.join(tempDir, "frozen-memory.jsonl");
    let sessionMemoryEnabled = true;
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      memoryMasterEnabled: false,
      get sessionMemoryEnabled() { return sessionMemoryEnabled; },
      get memoryEnabled() { return this.memoryMasterEnabled && sessionMemoryEnabled; },
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      getToolsSnapshot: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? [{ name: "search_memory" }] : [{ name: "todo_write" }],
      ),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
      ),
      buildMemoryReflectionSnapshot: vi.fn(({ forceMemoryEnabled } = {}) => ({
        version: 1,
        agentName: "Hana",
        userName: "测试用户",
        existingMemory: forceMemoryEnabled ? "已有长期记忆" : "",
      })),
      config: { tools: {} },
      tools: [{ name: "todo_write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "test-model", provider: "test" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "test-model", provider: "test", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
    const meta = JSON.parse(fs.readFileSync(path.join(tempDir, "hana", "sessions", "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].memoryEnabled).toBe(false);
    expect(agent.buildMemoryReflectionSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: false,
    });
    expect(meta[path.basename(sessionFile)].memoryReflectionSnapshot).toEqual({
      version: 1,
      agentName: "Hana",
      userName: "测试用户",
      existingMemory: "",
    });
  });

  it("blocks provider calls when an existing session cache prefix mutates without renew", async () => {
    const sessionFile = path.join(tempDir, "hana", "sessions", "cache-contract.jsonl");
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const bashTool = { name: "bash", description: "Run shell", parameters: { type: "object" } };
    const activeTools = new Map([["read", readTool], ["bash", bashTool]]);
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      model,
      getContextUsage: () => ({ tokens: 0 }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.map((name) => activeTools.get(name)).filter(Boolean);
      }),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool, bashTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool, bashTool], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    await expect(session.agent.streamFn(model, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool, bashTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");

    await expect(session.agent.streamFn(model, {
      systemPrompt: "MUTATED CACHE PREFIX",
      tools: [readTool, bashTool],
      messages: [
        { role: "user", content: "hello" },
        { role: "toolResult", content: [{ type: "text", text: "dynamic" }] },
      ],
    }, {})).rejects.toThrow(/Cache prefix contract violated/);
    expect(originalStreamFn).toHaveBeenCalledTimes(1);
  });

  it("renews the cache prefix contract for an explicit model switch", async () => {
    const sessionFile = path.join(tempDir, "hana", "sessions", "cache-contract-model-switch.jsonl");
    const initialModel = {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const nextModel = { ...initialModel, id: "deepseek-v4-pro" };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      model: initialModel,
      getContextUsage: () => ({ tokens: 0 }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.includes("read") ? [readTool] : [];
      }),
      setModel: vi.fn(async (model) => {
        session.model = model;
        session.agent.state.model = model;
      }),
      setThinkingLevel: vi.fn(),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model: initialModel,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: initialModel,
        availableModels: [initialModel, nextModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    await coordinator.switchSessionModel(sessionFile, nextModel);

    await expect(session.agent.streamFn(nextModel, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: { id: "default-model", provider: "test" } } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("subagent task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("releases a streaming session immediately when the provider abort never settles", async () => {
    const sessionFile = path.join(tempDir, "stuck-stream.jsonl");
    const emitEvent = vi.fn();
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const abort = vi.fn(() => new Promise(() => {}));
    const stuckSession = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => sessionFile },
      abort,
      dispose,
      extensionRunner: null,
    };

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator.sessions.set(sessionFile, {
      session: stuckSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: unsubscribe,
    });
    coordinator._session = stuckSession;

    const result = await Promise.race([
      coordinator.abortSession(sessionFile),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(coordinator.isSessionStreaming(sessionFile)).toBe(false);
    expect(coordinator.session).toBeNull();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false, aborted: true }),
      sessionFile,
    );
  });

  it("executeIsolated builds non-session tools from the master memory switch, not the focused session switch", async () => {
    const sessionFile = path.join(tempDir, "isolated-master-tools.jsonl");
    const builtinTool = { name: "read" };
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    const getToolsSnapshot = vi.fn(({ forceMemoryEnabled } = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [builtinTool],
      customTools,
    }));
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: false,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "MEMORY MASTER PROMPT",
      tools: [plainTool],
      getToolsSnapshot,
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check");

    expect(getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      model: { id: "default-model", provider: "test" },
    });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("executeIsolated activates a cold target agent before reading its runtime tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-cold-agent.jsonl");
    const calls = [];
    const getToolsSnapshot = vi.fn(() => {
      calls.push("tools");
      return [{ name: "write" }];
    });
    const agent = {
      id: "cold-agent",
      agentDir: path.join(tempDir, "agents", "cold-agent"),
      sessionDir: path.join(tempDir, "agents", "cold-agent", "sessions"),
      agentName: "cold-agent",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "BACKGROUND PROMPT",
      getToolsSnapshot,
    };
    const ensureAgentRuntime = vi.fn(async (agentId) => {
      calls.push("ensure");
      expect(agentId).toBe("cold-agent");
      return agent;
    });

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => ({ id: "focus" }),
      getActiveAgentId: () => "focus",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map([["cold-agent", agent]]),
      getActivityStore: () => null,
      getAgentById: (agentId) => (agentId === "cold-agent" ? agent : null),
      ensureAgentRuntime,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check", { agentId: "cold-agent" });

    expect(ensureAgentRuntime).toHaveBeenCalledOnce();
    expect(getToolsSnapshot).toHaveBeenCalledOnce();
    expect(calls).toEqual(["ensure", "tools"]);
  });

  it("executeIsolated runs background tools in operate mode instead of ask mode", async () => {
    const sessionFile = path.join(tempDir, "isolated-operate-permission.jsonl");
    let getPermissionMode;
    const buildTools = vi.fn((_cwd, customTools, opts) => {
      getPermissionMode = opts.getPermissionMode;
      return { tools: [], customTools };
    });
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [{ name: "write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("background check");

    expect(result.error).toBeNull();
    expect(buildTools).toHaveBeenCalledOnce();
    expect(getPermissionMode).toEqual(expect.any(Function));
    expect(getPermissionMode()).toBe("operate");
    expect(getPermissionMode(sessionFile)).toBe("operate");
  });

  it("executeIsolated appends execution-scoped custom tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-extra-tool.jsonl");
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [],
      customTools,
    }));
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: {
        models: { chat: { id: "default-model", provider: "test" } },
        desk: { patrol_tools: [] },
      },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [{ name: "write" }],
    };
    const scopedTool = { name: "jian_update_status", execute: vi.fn() };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      ensureAgentRuntime: async () => agent,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("background check", {
      activityType: "heartbeat",
      extraCustomTools: [scopedTool],
    });

    expect(result.error).toBeNull();
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toEqual(["jian_update_status"]);
  });

  it("executeIsolated builds sandboxed tools against the inherited execution cwd", async () => {
    const sessionFile = path.join(tempDir, "isolated-cwd-tools.jsonl");
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const inheritedCwd = path.join(tempDir, "inherited-session-cwd");
    const parentSessionPath = path.join(tempDir, "agents", "hana", "sessions", "parent.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => inheritedCwd,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check", {
      cwd: inheritedCwd,
      fileReadSessionPaths: [parentSessionPath],
    });

    expect(buildTools).toHaveBeenCalledWith(
      inheritedCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: inheritedCwd,
        getSessionPath: expect.any(Function),
        fileReadSessionPaths: [parentSessionPath],
      }),
    );
  });

  it("executeIsolated builds the subagent prompt against the inherited execution cwd", async () => {
    const sessionFile = path.join(tempDir, "isolated-cwd-prompt.jsonl");
    const inheritedCwd = path.join(tempDir, "inherited-session-cwd");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: vi.fn(({ cwdOverride } = {}) => `SUBAGENT PROMPT ${cwdOverride || "missing"}`),
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => inheritedCwd,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => path.join(tempDir, "agent-home"),
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check", {
      cwd: inheritedCwd,
      subagentContext: true,
    });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        forSubagent: true,
        cwdOverride: inheritedCwd,
      }),
    );
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt())
      .toBe(`SUBAGENT PROMPT ${inheritedCwd}`);
  });

  it("executeIsolated reports incomplete final assistant stop reasons", async () => {
    const sessionFile = path.join(tempDir, "isolated-length.jsonl");
    let subscriber;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "text", text: "partial" }],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("background check", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.replyText).toBe("partial");
    expect(result.stopReason).toBe("length");
    expect(result.error).toMatch(/length|limit|未完成|截断/);
  });

  it("executeIsolated returns session files produced by write/edit tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-files.jsonl");
    const producedFile = { filePath: path.join(tempDir, "report.md"), label: "report.md" };
    let subscriber;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({
          type: "tool_execution_end",
          toolName: "write",
          isError: false,
          result: { details: { sessionFile: producedFile } },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("write a report", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.error).toBeNull();
    expect(result.stopReason).toBe("stop");
    expect(result.sessionFiles).toEqual([producedFile]);
  });

  it("switchSession 拒绝 subagent-sessions/activity/.ephemeral 等旁路路径", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({ sessionDir: "/tmp/agents/hana/sessions" }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await expect(
      coordinator.switchSession("/tmp/agents/hana/subagent-sessions/child.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/activity/tick.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/.ephemeral/iso.jsonl"),
    ).rejects.toThrow(/path must be in/);
  });

  it("listSessions 不给旁路路径（subagent-sessions 等）伪造占位条目", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "hana", "sessions"),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
    });

    // 模拟焦点被污染到 subagent-sessions 下
    const subagentPath = path.join(tempDir, "hana", "subagent-sessions", "child.jsonl");
    coordinator._session = {
      sessionManager: {
        getSessionFile: () => subagentPath,
        getCwd: () => "/tmp/home",
      },
    };
    coordinator._sessionStarted = true;

    const sessions = await coordinator.listSessions();
    expect(sessions.find((s) => s.path === subagentPath)).toBeUndefined();
  });
});
