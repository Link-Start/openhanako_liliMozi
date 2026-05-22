import { describe, expect, it, vi } from "vitest";
import { createAutomationTool } from "../lib/tools/automation-tool.js";

function makeStore(id = "studio_job_1") {
  return {
    addJob: vi.fn((jobData) => ({ ...jobData, id, enabled: true })),
    listJobs: vi.fn(() => []),
  };
}

describe("automation tool", () => {
  it("creates notify automation jobs directly when auto approve is enabled by default", async () => {
    const store = makeStore();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const emitted = [];
    const tool = createAutomationTool(store, {
      confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/fallback",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: () => "/home/agent-a",
    });

    const result = await tool.execute(
      "call_1",
      {
        action: "add_notify",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Drink Water",
        title: "喝水",
        body: "站起来活动一下",
        channels: ["desktop"],
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/sessions/agent-a.jsonl",
          getCwd: () => "/workspace/current",
        },
      },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(result.details).toMatchObject({ action: "added", confirmed: true });
    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "",
      label: "Drink Water",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/current",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "direct_action",
        action: "notify",
        params: {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
      },
      createdBy: {
        kind: "agent",
        agentId: "agent-a",
        sourceSessionPath: "/sessions/agent-a.jsonl",
      },
    }));
  });

  it("asks for confirmation when automation auto approve is disabled", async () => {
    const store = makeStore();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const emitted = [];
    const tool = createAutomationTool(store, {
      getAutoApprove: () => false,
      confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_2",
      {
        action: "add_notify",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        title: "提醒",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(confirmStore.create).toHaveBeenCalledWith(
      "cron",
      { jobData: expect.objectContaining({ label: "Reminder" }) },
      "/sessions/agent-a.jsonl",
    );
    expect(emitted).toEqual([{
      sessionPath: "/sessions/agent-a.jsonl",
      event: {
        type: "cron_confirmation",
        confirmId: "confirm_1",
        jobData: expect.objectContaining({ label: "Reminder" }),
      },
    }]);
    expect(store.addJob).toHaveBeenCalledOnce();
  });

  it("creates plugin action automation job data", async () => {
    const store = makeStore("studio_job_2");
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_3",
      {
        action: "add_plugin_action",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        label: "Daily Note",
        pluginId: "notes",
        actionId: "create_note",
        params: { title: "Today", folder: "daily" },
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "",
      label: "Daily Note",
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        params: { title: "Today", folder: "daily" },
      },
    }));
  });

  it("rejects removed file.create automation actions", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_4",
      {
        action: "add_file_create",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        relativePath: "notes/today.md",
        content: "# Today\n",
      },
      undefined,
      undefined,
      {},
    );

    expect(result.details).toMatchObject({
      action: "add_file_create",
      error: "unknown automation action: add_file_create",
    });
    expect(store.addJob).not.toHaveBeenCalled();
  });
});
