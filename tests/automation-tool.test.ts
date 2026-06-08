import { describe, expect, it, vi } from "vitest";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";

function makeStore(initialJobs: any[] = [], id = "studio_job_1") {
  const store: any = {
    addJob: vi.fn((jobData) => ({ ...jobData, id, enabled: true })),
    updateJob: vi.fn((jobId, fields) => ({ ...initialJobs.find((job) => job.id === jobId), ...fields, id: jobId })),
    getJob: vi.fn((jobId) => initialJobs.find((job) => job.id === jobId) || null),
    listJobs: vi.fn(() => initialJobs),
  };
  return store;
}

function makeSuggestionStore(id = "automation_suggestion_1", shortCode = "3827") {
  const created: any[] = [];
  const store = {
    create: vi.fn((entry) => {
      const suggestion = { ...entry, suggestionId: id, shortCode };
      created.push(suggestion);
      return suggestion;
    }),
  };
  return { store, created };
}

describe("automation tool", () => {
  it("creates generic Agent-run automation suggestions by default", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore();
    const confirmStore = { create: vi.fn() };
    const tool = createAutomationTool(store, {
      confirmStore,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_1",
      {
        action: "create",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes and send a short summary.",
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/sessions/agent-a.jsonl",
          getCwd: () => "/workspace/current",
        },
        bridgeContext: {
          isBridgeSession: true,
          sessionKey: "wechat_dm_owner@agent-a",
          platform: "wechat",
        },
      },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(suggestionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPath: "/sessions/agent-a.jsonl",
        bridgeSessionKey: "wechat_dm_owner@agent-a",
        operation: "create",
        jobData: expect.objectContaining({
          label: "Morning Review",
          actorAgentId: "agent-b",
        }),
        apply: expect.any(Function),
      }),
    );
    expect(result.details).toMatchObject({
      action: "pending_add",
      operation: "create",
      suggestionId: "automation_suggestion_1",
      suggestionShortCode: "3827",
      automationSuggestion: {
        suggestionId: "automation_suggestion_1",
        shortCode: "3827",
        operation: "create",
      },
    });
    expect("confirmId" in result.details).toBe(false);
    expect(result.content[0].text).not.toContain("/confirm");
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("uses edited suggestion fields when an automation suggestion is applied", async () => {
    const store = makeStore();
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_2", "4812");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_2",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "original prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(store.addJob).not.toHaveBeenCalled();

    await created[0].apply({
      jobData: {
        label: "Edited Reminder",
        schedule: "30 10 * * *",
        prompt: "edited agent run prompt",
        actorAgentId: "agent-b",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-b",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-b",
        },
      },
    });

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      label: "Edited Reminder",
      schedule: "30 10 * * *",
      prompt: "edited agent run prompt",
      actorAgentId: "agent-b",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-b",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-b",
      },
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "edited agent run prompt",
      }),
    }));
  });

  it("updates existing automations only after the update suggestion is applied", async () => {
    const existingJob = {
      id: "studio_job_9",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "old prompt",
      label: "Old automation",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "old prompt",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_update", "9031");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_update",
      {
        action: "update",
        id: "studio_job_9",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "30 12 * * *",
        label: "Lunch automation",
        prompt: "new prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(result.details).toMatchObject({
      action: "pending_update",
      operation: "update",
      suggestionId: "automation_suggestion_update",
      suggestionShortCode: "9031",
      jobData: expect.objectContaining({
        id: "studio_job_9",
        actorAgentId: "agent-b",
      }),
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.updateJob).not.toHaveBeenCalled();

    await created[0].apply();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_9", expect.objectContaining({
      type: "cron",
      schedule: "30 12 * * *",
      label: "Lunch automation",
      prompt: "new prompt",
      actorAgentId: "agent-b",
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "new prompt",
      }),
    }));
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("preserves existing fields when an update suggestion only changes the schedule", async () => {
    const existingJob = {
      id: "studio_job_keep_fields",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "send the daily note",
      label: "Daily note",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "send the daily note",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_keep", "1204");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_update_keep_fields",
      {
        action: "update",
        id: "studio_job_keep_fields",
        scheduleType: "cron",
        schedule: "30 9 * * *",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    await created[0].apply();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_keep_fields", expect.objectContaining({
      schedule: "30 9 * * *",
      label: "Daily note",
      prompt: "send the daily note",
      actorAgentId: "agent-a",
    }));
  });

  it("falls back to an inline suggestion result when no suggestion store is available", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_inline",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 8 * * *",
        label: "Breakfast",
        prompt: "eat breakfast",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(result.details).toMatchObject({
      action: "pending_add",
      suggestionId: "",
      suggestionShortCode: "",
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("creates immediately only when auto approve is explicitly enabled", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_3", "6001");
    const confirmStore = { create: vi.fn() };
    const tool = createAutomationTool(store, {
      getAutoApprove: () => true,
      confirmStore,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_3",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(suggestionStore.create).not.toHaveBeenCalled();
    expect(store.addJob).toHaveBeenCalledOnce();
  });

  it("only declares create/update as deferred drafts when direct auto approve is disabled", () => {
    const deferredTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => false,
    });
    const directCommitTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => true,
    });

    expect(deferredTool.sessionPermission.describeSideEffect({ action: "create" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "update" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "list" })).toBeNull();
    expect(directCommitTool.sessionPermission.describeSideEffect({ action: "create" })).toBeNull();
  });

  it("rejects unknown automation actions", async () => {
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
