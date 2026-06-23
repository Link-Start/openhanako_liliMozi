import { describe, expect, it, vi } from "vitest";
import { createApprovalGateway } from "../lib/approval-gateway.ts";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.ts";

const ctx = {
  sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
};

function makeTool(name = "write", extras: any = {}) {
  return {
    name,
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "executed" }],
      details: { executed: true },
    })),
    ...extras,
  };
}

function makeAutomationStore() {
  return {
    addJob: vi.fn((jobData) => ({ ...jobData, id: "studio_job_1", enabled: true })),
    updateJob: vi.fn(),
    getJob: vi.fn(() => null),
    listJobs: vi.fn(() => []),
  };
}

describe("session permission wrapper", () => {
  it("blocks side-effect tools in read-only mode", async () => {
    const tool = makeTool("write");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("allows file stat in read-only mode", async () => {
    const tool = makeTool("file");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { action: "stat", fileId: "sf_1" }, null, null, ctx);

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("allows plugin tools declared read-only in read-only mode", async () => {
    const tool = makeTool("office_list-capabilities", {
      _pluginId: "office",
      sessionPermission: { readOnly: true },
    });
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "allow", reviewer: "small_tool_model", risk: "low" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-1", {}, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("blocks file copy in read-only mode", async () => {
    const tool = makeTool("file");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { action: "copy", fileId: "sf_1" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("asks before running the transitional file tool in ask mode", async () => {
    const tool = makeTool("file");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "copy", fileId: "sf_1" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "file" }),
      "/tmp/session.jsonl",
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("asks before running side-effect tools in ask mode", async () => {
    const tool = makeTool("write");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "write" }),
      "/tmp/session.jsonl",
    );
    expect(emitted[0]).toMatchObject({
      sessionPath: "/tmp/session.jsonl",
      event: {
        type: "session_confirmation",
        request: {
          type: "session_confirmation",
          kind: "tool_action_approval",
          status: "pending",
        },
      },
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("does not run side-effect tools when ask mode is rejected", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmed).toBe(false);
  });

  it("operate mode bypasses approval gateway and human confirmations", async () => {
    const tool = makeTool("write");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "should not run",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("operate mode lets ordinary git push behave like regular bash", async () => {
    const tool = makeTool("bash");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "should not review operate bash",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { command: "git push origin main" }, null, null, ctx);

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(result.details.executed).toBe(true);
  });

  it("hard safety policy blocks dangerous git push variants even in operate mode", async () => {
    const tool = makeTool("bash");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "allow", reviewer: "small_tool_model", risk: "low" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { command: "git push --force-with-lease origin main" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      errorCode: "ACTION_BLOCKED_BY_SAFETY_POLICY",
      ruleIds: ["force-push-blocked"],
      toolName: "bash",
    });
  });

  it("auto mode runs sandbox-bound workspace actions without approval gateway or human confirmation", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "workspace write is in scope",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      getSessionIdForPath: (sessionPath) => sessionPath === "/tmp/session.jsonl" ? "sess_tool_permission" : null,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode lets plugin-output tools run when the plugin declares bounded session output", async () => {
    const tool = makeTool("office_html-to-pdf", {
      _pluginId: "office",
      sessionPermission: { kind: "plugin_output" },
    });
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "deny_and_continue", reviewer: "small_tool_model", risk: "high" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { html: "<h1>Hi</h1>" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode sends plugin tools with external side effects to the approval reviewer", async () => {
    const tool = makeTool("media_generate-image", {
      _pluginId: "media",
      sessionPermission: {
        kind: "external_side_effect",
        describeSideEffect: (params) => ({
          kind: "external_generation",
          summary: `Generate image through provider ${params.provider || "default"}.`,
          risk: "medium",
          ruleId: "plugin-media-generation",
        }),
      },
    });
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "generation matches user intent",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { prompt: "cover", provider: "openai" }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "media_generate-image",
        sideEffect: expect.objectContaining({
          kind: "external_generation",
          summary: "Generate image through provider openai.",
          ruleId: "plugin-media-generation",
        }),
      }),
      expect.any(Object),
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode lets automation draft generation run without a tool-action confirmation", async () => {
    const store = makeAutomationStore();
    const confirmStore = { create: vi.fn() };
    const automationSuggestionStore = {
      create: vi.fn((entry) => ({
        ...entry,
        suggestionId: "automation_suggestion_1",
        shortCode: "3827",
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      automationSuggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => createApprovalGateway(),
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute(
      "call-automation-draft",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      null,
      null,
      ctx,
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(automationSuggestionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/session.jsonl",
      operation: "create",
      apply: expect.any(Function),
    }));
    expect(result.details).toMatchObject({
      action: "pending_add",
      suggestionId: "automation_suggestion_1",
      suggestionShortCode: "3827",
    });
    expect(result.details.confirmId).toBeUndefined();
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("defaults missing permission mode to auto and runs sandbox-bound workspace actions directly", async () => {
    const tool = makeTool("write");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "default auto reviewer approved",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode does not run a denied reviewer-bound action and returns the reviewer reason to the agent", async () => {
    const tool = makeTool("browser");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "use a safer local command",
        saferAlternative: "inspect files without shelling out",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#pay" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      confirmed: false,
      confirmation: {
        kind: "tool_action_approval",
        status: "denied",
        toolName: "browser",
        reason: "use a safer local command",
        reviewer: "small_tool_model",
      },
    });
  });

  it("auto mode does not fall back to human confirmation when the gateway asks the user", async () => {
    const tool = makeTool("browser");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-auto-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "reviewer unavailable",
        risk: "medium",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation).toMatchObject({
      kind: "tool_action_approval",
      status: "needs_user_approval_but_unavailable",
      toolName: "browser",
      reviewStatus: "ask_user",
      reason: "reviewer unavailable",
      reviewer: "policy",
      risk: "medium",
    });
  });

  it("passes trust context to the auto reviewer for reviewer-bound tool actions", async () => {
    const tool = makeTool("browser");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "trusted workspace target",
        risk: "low",
      })),
    };
    const runtimeCtx = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
      agentId: "hana",
      userIntentSummary: "Click the send button in the local preview",
      explicitUserAuthorization: "User asked to submit the local preview form.",
      recentApprovalHistory: [{ toolName: "browser", action: "navigate", status: "approved" }],
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      cwd: "/workspace/project",
      workspaceFolders: ["/workspace/project", "/workspace/shared"],
      authorizedFolders: ["/external/assets-static"],
      getAuthorizedFolders: () => ["/external/assets-live"],
      knownRemotes: ["origin git@example.com:hana/project.git"],
      knownDomains: ["localhost"],
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, runtimeCtx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser",
        sessionPath: "/tmp/session.jsonl",
        agentId: "hana",
      }),
      expect.objectContaining({
        sessionPath: "/tmp/session.jsonl",
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/project", "/workspace/shared"],
        authorizedFolders: ["/external/assets-live"],
        knownRemotes: ["origin git@example.com:hana/project.git"],
        knownDomains: ["localhost"],
        userIntentSummary: "Click the send button in the local preview",
        explicitUserAuthorization: "User asked to submit the local preview form.",
        recentApprovalHistory: [{ toolName: "browser", action: "navigate", status: "approved" }],
      }),
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode returns needs_user_approval_but_unavailable when reviewer asks in a non-interactive context", async () => {
    const tool = makeTool("browser");
    const confirmStore = {
      create: vi.fn(),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "bridge cannot ask the user",
        risk: "medium",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      allowHumanApproval: false,
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation.status).toBe("needs_user_approval_but_unavailable");
    expect(result.details.confirmation.reviewStatus).toBe("ask_user");
    expect(result.details.confirmation.reason).toBe("bridge cannot ask the user");
  });

  it("ask mode returns needs_user_approval_but_unavailable when approval policy cannot ask", async () => {
    const tool = makeTool("write");
    const confirmStore = { create: vi.fn() };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      approvalPolicy: "deny_on_prompt",
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation).toMatchObject({
      kind: "tool_action_approval",
      status: "needs_user_approval_but_unavailable",
      approvalPolicy: "deny_on_prompt",
      toolName: "write",
    });
  });

  // ---- 甲（Codex 式）端到端：permissionContext 透传到 classify ----

  it("subagent 上下文拦 subagent 工具（防自递归），即便 operate 全放行也拦，真实工具不执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate", // 即便最宽松的 operate
      permissionContext: { isSubagent: true },
    });
    const result = await wrapped.execute("call-1", { task: "递归" }, null, null, ctx);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_IN_SUBAGENT");
  });

  it("subagent 上下文 + read-only：write 被拦、read 放行（探索者只读档的执行层证明）", async () => {
    const write = makeTool("write");
    const read = makeTool("read");
    const [wWrite, wRead] = wrapWithSessionPermission([write, read], {
      getPermissionMode: () => "read_only",
      permissionContext: { isSubagent: true },
    });
    const wr = await wWrite.execute("c1", { path: "x" }, null, null, ctx);
    const rd = await wRead.execute("c2", { path: "x" }, null, null, ctx);
    expect(write.execute).not.toHaveBeenCalled();
    expect(wr.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
    expect(read.execute).toHaveBeenCalledOnce();
    expect(rd.details.executed).toBe(true);
  });

  it("对照：无 permissionContext 时 subagent 工具在 operate 下正常执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
    });
    const result = await wrapped.execute("call-1", { task: "x" }, null, null, ctx);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });
});
