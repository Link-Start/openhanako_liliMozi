import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCronSchedulerMock, schedulers } = vi.hoisted(() => ({
  createCronSchedulerMock: vi.fn(),
  schedulers: [],
}));

vi.mock("../lib/desk/cron-scheduler.js", () => ({
  createCronScheduler: createCronSchedulerMock,
}));

vi.mock("../lib/desk/heartbeat.js", () => ({
  HEARTBEAT_ACTIVITY_DIR: ".hana-heartbeat",
  createHeartbeat: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../lib/fresh-compact/daily-scheduler.js", () => ({
  createFreshCompactDailyScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../hub/fresh-compact-maintainer.js", () => ({
  FreshCompactMaintainer: vi.fn().mockImplementation(function () {
    this.runDaily = vi.fn();
  }),
}));

import { Scheduler } from "../hub/scheduler.js";

describe("Scheduler studio cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedulers.length = 0;
    createCronSchedulerMock.mockImplementation((opts) => {
      const scheduler = {
        opts,
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        checkJobs: vi.fn(),
      };
      schedulers.push(scheduler);
      return scheduler;
    });
  });

  it("starts one studio cron scheduler instead of one scheduler per agent directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      fs.mkdirSync(path.join(root, "agents", "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(root, "agents", "agent-b"), { recursive: true });
      const studioStore = { listJobs: vi.fn(() => []) };
      const engine = {
        agentsDir: path.join(root, "agents"),
        agents: new Map(),
        getStudioCronStore: () => studioStore,
        getHeartbeatMaster: () => false,
      };

      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();

      expect(createCronSchedulerMock).toHaveBeenCalledTimes(1);
      expect(createCronSchedulerMock.mock.calls[0][0].cronStore).toBe(studioStore);
      expect(schedulers[0].start).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes a studio cron job with its actorAgentId and captured executionContext", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
      const activityStore = { add: vi.fn() };
      const executeIsolated = vi.fn(async () => ({ sessionPath: "", error: null }));
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => activityStore),
        emitDevLog: vi.fn(),
      };
      const eventBus = { emit: vi.fn() };
      const scheduler = new Scheduler({ hub: { engine, eventBus } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await executeJob({
        id: "studio_job_1",
        label: "Agent B workspace job",
        prompt: "run in b",
        model: { id: "gpt-test", provider: "openai" },
        actorAgentId: "agent-b",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/b",
          workspaceFolders: ["/workspace/ref"],
          sourceSessionPath: "/sessions/b.jsonl",
          createdByAgentId: "agent-b",
        },
      });

      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run in b"),
        expect.objectContaining({
          agentId: "agent-b",
          cwd: "/workspace/b",
          workspaceFolders: ["/workspace/ref"],
          parentSessionPath: "/sessions/b.jsonl",
          model: { id: "gpt-test", provider: "openai" },
          activityType: "cron",
        }),
      );
      expect(activityStore.add).toHaveBeenCalledWith(expect.objectContaining({
        type: "cron",
        agentId: "agent-b",
        label: "Agent B workspace job",
      }));
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "activity_update" }),
        null,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes agent_session cron jobs through the executor read model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const activityStore = { add: vi.fn() };
      const executeIsolated = vi.fn(async () => ({ sessionPath: "", error: null }));
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => activityStore),
        emitDevLog: vi.fn(),
      };
      const eventBus = { emit: vi.fn() };
      const scheduler = new Scheduler({ hub: { engine, eventBus } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await executeJob({
        id: "studio_job_2",
        label: "Executor job",
        trigger: { kind: "cron", expression: "0 9 * * *" },
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run from executor",
          model: { id: "gpt-test", provider: "openai" },
          executionContext: {
            kind: "session_workspace",
            cwd: "/workspace/a",
            workspaceFolders: ["/workspace/ref"],
            sourceSessionPath: "/sessions/a.jsonl",
            createdByAgentId: "agent-a",
          },
        },
      });

      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run from executor"),
        expect.objectContaining({
          agentId: "agent-a",
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          parentSessionPath: "/sessions/a.jsonl",
          model: { id: "gpt-test", provider: "openai" },
          activityType: "cron",
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes notify direct-action cron jobs without creating an agent session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const executeIsolated = vi.fn();
      const deliverNotification = vi.fn(async () => ({
        ok: true,
        deliveries: [{ channel: "desktop", status: "sent" }],
      }));
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        executeIsolated,
        deliverNotification,
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      const result = await executeJob({
        id: "studio_job_notify",
        label: "Drink Water",
        actorAgentId: "agent-a",
        executor: {
          kind: "direct_action",
          action: "notify",
          params: {
            title: "喝水",
            body: "站起来活动一下",
            channels: ["desktop"],
          },
        },
      });

      expect(executeIsolated).not.toHaveBeenCalled();
      expect(deliverNotification).toHaveBeenCalledWith(
        {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
        { agentId: "agent-a" },
      );
      expect(result).toMatchObject({
        executorKind: "direct_action",
        action: "notify",
        delivery: {
          ok: true,
          deliveries: [{ channel: "desktop", status: "sent" }],
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes plugin-action cron jobs through plugin tools without creating an agent session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const executeIsolated = vi.fn();
      const pluginToolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
      const pluginTool = {
        name: "notes_create_note",
        _pluginId: "notes",
        _dynamic: true,
        execute: pluginToolExecute,
      };
      const executePluginTool = vi.fn(async (tool, invocation) => (
        tool._dynamic
          ? tool.execute(invocation.input, invocation.runtimeCtx)
          : tool.execute(invocation.toolCallId, invocation.input, invocation.runtimeCtx)
      ));
      const engine = {
        agentsDir,
        agents: new Map(),
        runtimeContext: null,
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        executeIsolated,
        pluginManager: {
          getPlugin: vi.fn(() => ({ id: "notes", status: "loaded" })),
          getPluginTool: vi.fn(() => pluginTool),
          executePluginTool,
        },
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      const result = await executeJob({
        id: "studio_job_plugin",
        label: "Daily note",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: { title: "Today" },
        },
      });

      expect(executeIsolated).not.toHaveBeenCalled();
      expect(executePluginTool).toHaveBeenCalledWith(
        pluginTool,
        {
          toolCallId: "automation-studio_job_plugin",
          input: { title: "Today" },
          runtimeCtx: {
            automation: { jobId: "studio_job_plugin", label: "Daily note" },
            agentId: "agent-a",
            sessionPath: "/sessions/a.jsonl",
            sessionManager: {
              getSessionFile: expect.any(Function),
              getCwd: expect.any(Function),
            },
          },
        },
      );
      expect(pluginToolExecute).toHaveBeenCalledWith(
        { title: "Today" },
        {
          automation: { jobId: "studio_job_plugin", label: "Daily note" },
          agentId: "agent-a",
          sessionPath: "/sessions/a.jsonl",
          sessionManager: {
            getSessionFile: expect.any(Function),
            getCwd: expect.any(Function),
          },
        },
      );
      expect(result).toEqual({
        executorKind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        result: { content: [{ type: "text", text: "ok" }] },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails plugin-action cron jobs explicitly when the plugin tool is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        pluginManager: {
          getPlugin: vi.fn(() => ({ id: "notes", status: "loaded" })),
          getPluginTool: vi.fn(() => null),
          executePluginTool: vi.fn(),
        },
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await expect(executeJob({
        id: "studio_job_plugin_missing",
        label: "Missing plugin action",
        actorAgentId: "agent-a",
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: {},
        },
      })).rejects.toThrow(/plugin action not found: notes\/create_note/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
