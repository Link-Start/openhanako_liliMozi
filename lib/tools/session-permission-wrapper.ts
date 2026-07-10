import {
  classifySessionPermission,
  normalizeSessionPermissionMode,
  resolveSessionApprovalPolicy,
  SESSION_APPROVAL_POLICIES,
  SESSION_PERMISSION_MODES,
} from "../../core/session-permission-mode.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { toolError, toolOk } from "./tool-result.ts";
import { t } from "../i18n.ts";
import { evaluateToolSafetyPolicy } from "../permission/safety-policy.ts";
import { buildApprovalReviewContext } from "../permission/approval-review-context.ts";

function findRuntimeCtx(args: any[]) {
  for (let i = args.length - 1; i >= 2; i--) {
    const value = args[i];
    if (value && typeof value === "object" && (value.sessionManager || value.sessionId || value.sessionPath || value.agentId || value.model)) {
      return value;
    }
  }
  return null;
}

function stableSessionKey(sessionPath: any, deps: any, ctx: any = null) {
  const ctxSessionId = typeof ctx?.sessionId === "string" && ctx.sessionId.trim()
    ? ctx.sessionId.trim()
    : null;
  const resolved = !ctxSessionId && typeof deps.getSessionIdForPath === "function"
    ? deps.getSessionIdForPath(sessionPath)
    : null;
  const sessionId = ctxSessionId || (typeof resolved === "string" && resolved.trim() ? resolved.trim() : null);
  return sessionId || sessionPath || "session";
}

function buildToolApprovalRequest(confirmId: any, toolName: any, params: any) {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "tool_action_approval",
    surface: "input",
    status: "pending",
    title: t("approval.toolAction.title"),
    body: t("approval.toolAction.body"),
    subject: {
      label: toolName,
      detail: summarizeParams(params),
    },
    severity: "elevated",
    actions: {
      confirmLabel: t("approval.confirm"),
      rejectLabel: t("approval.reject"),
    },
    payload: { toolName, params },
  };
}

function buildToolApprovalGatewayRequest(tool: any, toolName: any, params: any, sessionPath: any, stableKey: any, ctx: any = null, deps: any = {}) {
  const target = approvalTargetForTool(toolName, params);
  const sideEffect = approvalSideEffectForTool(tool, params);
  return {
    id: `${stableKey || "session"}:${toolName}:${Date.now()}`,
    kind: "tool_action",
    sessionPath,
    agentId: ctx?.agentId || deps.agentId || null,
    toolName,
    actionName: typeof params?.action === "string" ? params.action : "execute",
    params: params && typeof params === "object" ? params : {},
    target,
    blastRadius: target.type === "url" || target.type === "domain" ? "external" : "workspace",
    reversibility: toolName === "bash" || toolName === "exec_command" || toolName === "terminal" || toolName === "write_stdin" ? "unknown" : "moderate",
    ...(sideEffect ? { sideEffect } : {}),
  };
}

function approvalTargetForTool(toolName: any, params: any = {}) {
  const command = typeof params.command === "string"
    ? params.command
    : typeof params.cmd === "string"
      ? params.cmd
      : "";
  if (command) return { type: "command", label: command };
  const path = typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : "";
  if (path) return { type: "file", label: path, path };
  const url = typeof params.url === "string" ? params.url : "";
  if (url) return { type: "url", label: url, url };
  const label = typeof params.label === "string" && params.label.trim()
    ? params.label.trim()
    : toolName;
  return { type: "tool", label };
}

function approvalSideEffectForTool(tool: any, params: any) {
  const describe = tool?.sessionPermission?.describeSideEffect;
  const sideEffect = typeof describe === "function"
    ? describe(params)
    : tool?.sessionPermission?.sideEffect;
  return sideEffect && typeof sideEffect === "object" ? sideEffect : null;
}

function permissionContextForTool(tool: any, deps: any = {}) {
  const base = deps.permissionContext && typeof deps.permissionContext === "object"
    ? deps.permissionContext
    : {};
  const toolSessionPermission = tool?.sessionPermission && typeof tool.sessionPermission === "object"
    ? tool.sessionPermission
    : null;
  return {
    ...base,
    ...(toolSessionPermission ? { toolSessionPermission } : {}),
    ...(tool?._pluginId ? { isPluginTool: true, pluginId: tool._pluginId } : {}),
  };
}

function summarizeParams(params: any) {
  if (!params || typeof params !== "object") return "";
  const keys = ["action", "path", "file_path", "command", "cmd", "process_id", "url", "key", "label"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 160)}`;
  }
  return "";
}

function toStatus(action: any) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

async function askForToolApproval(toolName: any, params: any, sessionPath: any, deps: any) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

async function reviewToolApproval(tool: any, toolName: any, params: any, sessionPath: any, deps: any, ctx: any = null) {
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return {
      allowed: false,
      status: "ask_user",
      reason: "approval-gateway-unavailable",
    };
  }
  const request = buildToolApprovalGatewayRequest(tool, toolName, params, sessionPath, stableSessionKey(sessionPath, deps, ctx), ctx, deps);
  const decision = await gateway.review(request, buildApprovalReviewContext({
    source: deps,
    ctx,
    sessionPath,
    agentId: request.agentId,
  }));
  if (decision?.action === "allow") {
    return { allowed: true, status: "approved", decision };
  }
  if (decision?.action === "ask_user") {
    return { allowed: false, status: "ask_user", decision, reason: decision.reason };
  }
  return {
    allowed: false,
    status: decision?.action === "hard_deny" ? "blocked" : "denied",
    decision,
    reason: decision?.reason
      ? `session permission auto-review: ${decision.reason}`
      : "session permission auto-review denied this action",
  };
}

function resolveToolPermissionMode(deps: any, sessionPath: any) {
  if (typeof deps.getPermissionMode !== "function") return SESSION_PERMISSION_MODES.AUTO;
  const scoped = deps.getPermissionMode(sessionPath);
  const raw = scoped ?? deps.getPermissionMode();
  if (raw == null) return SESSION_PERMISSION_MODES.AUTO;
  return normalizeSessionPermissionMode(raw);
}

function toolApprovalUnavailable(toolName: any, status = "needs_user_approval_but_unavailable", reason = "human approval unavailable", extras: any = {}) {
  return toolOk("Tool action needs user approval, but this execution context cannot ask the user.", {
    action: toolName,
    confirmed: false,
    confirmation: {
      kind: "tool_action_approval",
      status,
      toolName,
      reason,
      approvalPolicy: SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT,
      ...extras,
    },
  });
}

export function wrapWithSessionPermission(tools: any[] = [], deps: any = {}) {
  return tools.map((tool: any) => {
    if (!tool?.execute || tool._sessionPermissionWrapped) return tool;
    return {
      ...tool,
      _sessionPermissionWrapped: true,
      execute: async (...args: any[]) => {
        const params = args[1] || {};
        const ctx = findRuntimeCtx(args);
        const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
        const mode = resolveToolPermissionMode(deps, sessionPath);
        const approvalPolicy = resolveSessionApprovalPolicy({
          mode,
          approvalPolicy: deps.approvalPolicy,
          allowHumanApproval: deps.allowHumanApproval,
        });
        const gatewayRequest = buildToolApprovalGatewayRequest(tool, tool.name, params, sessionPath, stableSessionKey(sessionPath, deps, ctx), ctx, deps);
        const safety = evaluateToolSafetyPolicy(gatewayRequest);
        if (safety?.action === "block") {
          return toolError(safety.reason, {
            errorCode: safety.code,
            permissionMode: mode,
            toolName: tool.name,
            reviewer: safety.reviewer,
            risk: safety.risk,
            ruleIds: safety.ruleIds,
          });
        }
        const decision: any = classifySessionPermission({
          mode,
          toolName: tool.name,
          params,
          context: permissionContextForTool(tool, deps),
        });
        if (decision.action === "allow") {
          return tool.execute(...args);
        }
        if (decision.action === "deny") {
          return toolError(decision.message, {
            errorCode: decision.code,
            permissionMode: mode,
            toolName: tool.name,
            ...(decision.details || {}),
          });
        }
        if (decision.action === "review") {
          const review = await reviewToolApproval(tool, tool.name, params, sessionPath, deps, ctx);
          if (review.allowed) {
            return tool.execute(...args);
          }
          if (review.status !== "ask_user") {
            return toolOk("Tool action was not approved.", {
              action: tool.name,
              confirmed: false,
              confirmation: {
                kind: "tool_action_approval",
                status: review.status,
                toolName: tool.name,
                reason: review.reason,
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
              },
            });
          }
          if (approvalPolicy === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) {
            return toolApprovalUnavailable(tool.name, "needs_user_approval_but_unavailable", review.reason || "human approval unavailable", {
              reviewStatus: "ask_user",
              reviewer: review.decision?.reviewer,
              risk: review.decision?.risk,
            });
          }
        }

        if (approvalPolicy === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) {
          return toolApprovalUnavailable(tool.name);
        }
        const approval = await askForToolApproval(tool.name, params, sessionPath, deps);
        if (!approval.allowed) {
          return toolOk("Tool action was not approved.", {
            action: tool.name,
            confirmed: false,
            confirmation: {
              kind: "tool_action_approval",
              status: approval.status,
              confirmId: approval.confirmId,
              toolName: tool.name,
              reason: approval.reason,
            },
          });
        }
        return tool.execute(...args);
      },
    };
  });
}
