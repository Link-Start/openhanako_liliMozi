/**
 * Session 管理 REST 路由
 */
import { appendFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { extractBlocks, resolveMediaGenerationBlocks } from "../block-extractors.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { sessionIdFromFilename } from "../../lib/session-jsonl.js";
import { parseDeferredResultNotification } from "../../lib/deferred-result-notification.js";
import {
  materializeExecutorIdentity,
  readSubagentSessionMetaSync,
} from "../../lib/subagent-executor-metadata.js";
import {
  extractTextContent,
  filterUnreferencedInlineImages,
  loadSessionHistoryMessages,
  loadLatestAssistantSummaryFromSessionFile,
  isValidSessionPath,
  isActiveDesktopSessionPath,
  isArchivedDesktopSessionPath,
} from "../../core/message-utils.js";
import {
  loadLatestTodosFromSessionFile,
  loadLatestTodoSnapshotFromSessionFile,
} from "../../lib/tools/todo-compat.js";
import { SessionManager } from "../../lib/pi-sdk/index.js";
import { TODO_STATE_CUSTOM_TYPE } from "../../lib/tools/todo-constants.js";
import { mergeWorkspaceHistory } from "../../shared/workspace-history.js";
import {
  deleteSessionFileSidecarSync,
  moveSessionFileSidecarSync,
  sessionFileSidecarPath,
} from "../../lib/session-files/session-file-registry.js";
import { serializeSessionFile } from "../../lib/session-files/session-file-response.js";
import { deleteSessionSkillSnapshotSync } from "../../lib/skills/session-skill-snapshot.js";
import { browserScreenshotPath } from "../../lib/session-files/browser-screenshot-file.js";
import { modelSupportsXhigh } from "../../core/session-thinking-level.js";
import {
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.js";
import { replayLatestUserTurn } from "../../core/session-turn-actions.js";
import { createRequestContext } from "../http/boundary.js";
import { createModuleLogger } from "../../lib/debug-log.js";

const log = createModuleLogger("sessions");
const lifecycleLog = createModuleLogger("sessions/lifecycle");
const switchLog = createModuleLogger("sessions/switch");

function rcPlatformFromSessionKey(sessionKey) {
  const match = /^([a-z]+)_/i.exec(sessionKey || "");
  return match ? match[1] : "bridge";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function completeTodoItems(todos) {
  return (Array.isArray(todos) ? todos : []).map((todo) => ({
    ...todo,
    status: "completed",
  }));
}

function getWritableSessionManager(engine, sessionPath) {
  const liveSession = engine.getSessionByPath?.(sessionPath);
  if (liveSession?.sessionManager) return liveSession.sessionManager;
  return SessionManager.open(sessionPath, path.dirname(sessionPath));
}

function authorizeSessionRoute(requestContext, capability, target) {
  if (requestContext.authPrincipal?.kind === "unknown") return { allowed: true, reason: "legacy_test_context" };
  if (typeof requestContext.authorize !== "function") return { allowed: false, reason: "missing_policy" };
  return requestContext.authorize(capability, target);
}

const TODO_COMPLETE_MESSAGE =
  "[Hana Todo] The user marked the current todo list as completed and removed it from the session UI. Treat every item in that list as completed. Create a new todo list only if new work needs tracking.";

export function createSessionsRoute(engine, hub = null) {
  const route = new Hono();

  // session-meta.json sidecar 按 session 目录共享；同一个 request 里遍历几十个 block
  // 时不必每个 block 都重复 readFileSync + JSON.parse。调用端构造一次 Map 当 cache。
  function createSubagentMetaCache() {
    const map = new Map();
    return (sessionPath) => {
      if (!sessionPath) return null;
      if (map.has(sessionPath)) return map.get(sessionPath);
      const meta = readSubagentSessionMetaSync(sessionPath);
      map.set(sessionPath, meta);
      return meta;
    };
  }

  function applySubagentIdentity(block, task, readSessionMeta) {
    const sessionPath = block.streamKey || task?.meta?.sessionPath || null;
    const sessionMeta = readSessionMeta(sessionPath);
    const resolved =
      materializeExecutorIdentity(sessionMeta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(task?.meta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(block, engine.getAgent?.bind(engine));

    if (resolved) {
      block.agentId = resolved.agentId;
      block.agentName = resolved.agentName;
      return;
    }

    const inferredAgentId = sessionPath
      ? engine.agentIdFromSessionPath?.(sessionPath) || null
      : null;
    if (!inferredAgentId) return;

    const inferredAgent = engine.getAgent?.(inferredAgentId) || null;
    block.agentId = inferredAgentId;
    block.agentName = inferredAgent?.agentName || "Unknown agent";
  }

  function patchBlockExecutorMetadata(block, task, readSessionMeta) {
    const sessionPath = block.streamKey || task?.meta?.sessionPath || null;
    const sessionMeta = readSessionMeta(sessionPath);
    const sources = [sessionMeta, task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.executorAgentId && !block.executorAgentId) {
        block.executorAgentId = source.executorAgentId;
      }
      if (source.executorAgentNameSnapshot && !block.executorAgentNameSnapshot) {
        block.executorAgentNameSnapshot = source.executorAgentNameSnapshot;
      }
      if (source.executorMetaVersion && !block.executorMetaVersion) {
        block.executorMetaVersion = source.executorMetaVersion;
      }
    }
  }

  function patchBlockRequestedMetadata(block, task = null) {
    const sources = [task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.requestedAgentId && !block.requestedAgentId) {
        block.requestedAgentId = source.requestedAgentId;
      }
      if (source.requestedAgentNameSnapshot && !block.requestedAgentName) {
        block.requestedAgentName = source.requestedAgentNameSnapshot;
      }
    }
  }

  function taskFromSubagentRun(run) {
    if (!run) return null;
    return {
      status: run.status,
      result: run.summary || null,
      reason: run.reason || run.summary || null,
      meta: {
        sessionPath: run.childSessionPath || null,
        requestedAgentId: run.requestedAgentId || null,
        requestedAgentNameSnapshot: run.requestedAgentNameSnapshot || null,
        executorAgentId: run.executorAgentId || null,
        executorAgentNameSnapshot: run.executorAgentNameSnapshot || null,
        executorMetaVersion: run.executorMetaVersion || null,
      },
    };
  }

  function mergeSubagentTaskMetadata(primary, fallback) {
    if (!primary) return fallback || null;
    if (!fallback) return primary;
    const primaryMeta = {};
    for (const [key, value] of Object.entries(primary.meta || {})) {
      if (value != null) primaryMeta[key] = value;
    }
    return {
      status: primary.status || fallback.status,
      result: primary.result ?? fallback.result,
      reason: primary.reason ?? fallback.reason,
      meta: {
        ...(fallback.meta || {}),
        ...primaryMeta,
      },
    };
  }

  function createSubagentSummaryCache() {
    const map = new Map();
    return async (sessionPath) => {
      if (!sessionPath) return null;
      if (!map.has(sessionPath)) {
        map.set(sessionPath, loadLatestAssistantSummaryFromSessionFile(sessionPath));
      }
      return await map.get(sessionPath);
    };
  }

  function getSessionSummaryRecord(sessionPath, agentIdHint = null) {
    if (!sessionPath) return null;
    const agentId = agentIdHint || engine.agentIdFromSessionPath?.(sessionPath) || null;
    if (!agentId) return null;
    const agent = engine.getAgent?.(agentId) || null;
    const summaryManager = agent?.summaryManager || null;
    if (!summaryManager || typeof summaryManager.getSummary !== "function") return null;

    const sessionId = sessionIdFromFilename(path.basename(sessionPath));
    const record = summaryManager.getSummary(sessionId);
    return record?.summary?.trim() ? record : null;
  }

  function serializeSessionSummaryRecord(record) {
    return {
      hasSummary: !!record,
      summary: record?.summary || null,
      createdAt: record?.created_at || null,
      updatedAt: record?.updated_at || null,
    };
  }

  function invalidateRcTarget(sessionPath) {
    const rcState = engine.rcState;
    if (!rcState?.invalidateDesktopSession) return;

    const { detachedAttachments } = rcState.invalidateDesktopSession(sessionPath);
    for (const attachment of detachedAttachments) {
      try {
        engine.emitEvent?.({
          type: "bridge_rc_detached",
          sessionKey: attachment.sessionKey,
          sessionPath: attachment.desktopSessionPath,
        }, attachment.desktopSessionPath);
      } catch {}
    }
  }

  function archivedPathForActiveSession(sessionPath) {
    return path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath));
  }

  function activePathForArchivedSession(sessionPath) {
    return path.join(path.dirname(path.dirname(sessionPath)), path.basename(sessionPath));
  }

  function uniqueLifecyclePaths(paths) {
    return [...new Set((paths || []).filter((p) => typeof p === "string" && p.trim()))];
  }

  async function cleanupSessionLifecycle(sessionPaths, reason) {
    const bm = BrowserManager.instance();
    for (const sessionPath of uniqueLifecyclePaths(sessionPaths)) {
      try {
        engine.taskRegistry?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        lifecycleLog.warn(`task cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.subagentRuns?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        lifecycleLog.warn(`subagent run cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.deferredResults?.suppressBySession?.(sessionPath, reason);
      } catch (err) {
        lifecycleLog.warn(`deferred cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.confirmStore?.abortBySession?.(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`confirm cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        await engine.abortSessionByPath?.(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`session abort failed for ${sessionPath}: ${err.message}`);
      }
      try {
        await bm.closeBrowserForSession(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`browser cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.terminalSessions?.closeForSession?.(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`terminal cleanup failed for ${sessionPath}: ${err.message}`);
      }
      invalidateRcTarget(sessionPath);
    }
  }

  // 列出所有 agent 的历史 session
  route.get("/sessions", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const runtimeStudioId = requestContext.runtimeContext?.studioId || null;
      const principalStudioId = requestContext.authPrincipal?.studioId || null;
      // Same-Studio projection v0: paired clients may see the legacy session store
      // only when their authenticated Studio is the server's current Studio.
      if (runtimeStudioId && principalStudioId && runtimeStudioId !== principalStudioId) {
        return c.json({
          error: "studio_scope_mismatch",
          detail: "authenticated Studio does not match this server Studio",
        }, 403);
      }
      const sessions = await engine.listSessions();
      const attachments = engine.rcState?.listAttachments?.() || [];
      const rcAttachmentByPath = new Map(attachments.map((attachment) => [
        attachment.desktopSessionPath,
        {
          sessionKey: attachment.sessionKey,
          platform: rcPlatformFromSessionKey(attachment.sessionKey),
        },
      ]));
      return c.json(sessions.map(s => {
        const summaryRecord = getSessionSummaryRecord(s.path, s.agentId || null);
        return ({
          path: s.path,
          title: s.title || null,
          firstMessage: (s.firstMessage || "").slice(0, 100),
          modified: s.modified?.toISOString() || null,
          messageCount: s.messageCount || 0,
          cwd: s.cwd || null,
          agentId: s.agentId || null,
          agentName: s.agentName || null,
          modelId: s.modelId || null,
          modelProvider: s.modelProvider || null,
          permissionMode: typeof engine.getSessionPermissionMode === "function"
            ? engine.getSessionPermissionMode(s.path)
            : engine.permissionMode || null,
          pinnedAt: s.pinnedAt || null,
          hasSummary: !!summaryRecord,
          rcAttachment: rcAttachmentByPath.get(s.path)
            ? {
              ...rcAttachmentByPath.get(s.path),
              title: s.title || null,
            }
            : null,
        });
      }));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 获取单个 session 的滚动摘要。列表只暴露 hasSummary，正文按需读取。
  route.get("/sessions/summary", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const sessionPath = c.req.query("path") || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);

      const record = getSessionSummaryRecord(sessionPath);
      return c.json(serializeSessionSummaryRecord(record));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 置顶 / 取消置顶 session
  route.post("/sessions/pin", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const { path: sessionPath, pinned } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof pinned !== "boolean") {
        return c.json({ error: t("error.missingParam", { param: "pinned" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const pinnedAt = await engine.setSessionPinned(sessionPath, pinned);
      return c.json({ ok: true, pinnedAt });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 获取 session 的消息（支持 ?path= 指定 session，否则读焦点 session）
  route.get("/sessions/messages", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const queryPath = c.req.query("path") || null;
      if (queryPath && !isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath: queryPath || engine.currentSessionPath || null,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const sourceMessages = await loadSessionHistoryMessages(engine, queryPath);

      // 分页参数
      const beforeId = c.req.query("before") != null ? Number(c.req.query("before")) : null;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

      // 提取可显示的消息（user/assistant 文本 + 文件/artifact 工具结果）
      // 每条消息带稳定 id（原始 sourceMessages 索引）
      const allMessages = [];
      const blocks = [];
      const mediaGenerationResults = new Map();
      const standaloneMediaGenerationResults = [];
      let globalIdx = 0;

      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text, images } = extractTextContent(m.content);
          const visibleImages = filterUnreferencedInlineImages(text, images);
          if (text || visibleImages.length) {
            allMessages.push({
              id: String(globalIdx),
              ...(m.id ? { entryId: m.id } : {}),
              role: "user",
              content: text,
              images: visibleImages.length ? visibleImages : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
            globalIdx++;
          }
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            allMessages.push({
              id: String(globalIdx),
              ...(m.id ? { entryId: m.id } : {}),
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
            globalIdx++;
          }
        } else if (m.role === "toolResult") {
          const extracted = extractBlocks(m.toolName, m.details, m);
          for (const b of extracted) {
            blocks.push({ ...b, afterIndex: allMessages.length - 1 });
          }
        } else if (m.role === "custom" && m.customType === "hana-background-result") {
          const parsed = parseDeferredResultNotification(m.content);
          if (!parsed?.taskId || !isMediaGenerationDeferredResult(parsed)) continue;
          mediaGenerationResults.set(parsed.taskId, parsed);
          if (parsed.status === "success") {
            standaloneMediaGenerationResults.push({
              ...parsed,
              afterIndex: allMessages.length - 1,
            });
          }
        }
      }
      const resolvedBlocks = resolveMediaGenerationBlocks(
        blocks,
        mediaGenerationResults,
        standaloneMediaGenerationResults,
      );

      // 分页：before 参数指定游标，否则默认返回最后 limit 条
      let messages;
      let hasMore = false;
      let slicedBlocks = resolvedBlocks;

      const total = allMessages.length;
      // all=1 强制全量返回（流式恢复等特殊场景）
      const forceAll = c.req.query("all") === "1";

      if (forceAll) {
        messages = allMessages;
      } else {
        const endIdx = (beforeId != null && beforeId > 0)
          ? Math.min(beforeId, total)
          : total;
        const startIdx = Math.max(0, endIdx - limit);
        messages = allMessages.slice(startIdx, endIdx);
        hasMore = startIdx > 0;
        // 重映射 afterIndex 到切片内偏移，过滤超出范围的
        slicedBlocks = resolvedBlocks
          .filter(b => b.afterIndex >= startIdx && b.afterIndex < endIdx)
          .map(b => ({ ...b, afterIndex: b.afterIndex - startIdx }));
      }

      // 修正 subagent blocks 的状态：优先从 durable run registry 读长期映射，
      // 再用 deferred store 作为实时投递队列。deferred 会清理，不再承担历史事实源。
      {
        const deferredStore = engine.deferredResults;
        const runStore = engine.subagentRuns;
        const readSessionMeta = createSubagentMetaCache();
        const readSessionSummary = createSubagentSummaryCache();
        for (const b of slicedBlocks) {
          if (b.type !== "subagent" || !b.taskId) continue;
          const task = deferredStore?.query?.(b.taskId) || null;
          const run = runStore?.query?.(b.taskId) || null;
          const runTask = taskFromSubagentRun(run);
          const metadataTask = mergeSubagentTaskMetadata(runTask, task);
          const durableSessionPath = run?.childSessionPath || null;
          const deferredSessionPath = task?.meta?.sessionPath || null;
          if (!b.streamKey && durableSessionPath) b.streamKey = durableSessionPath;
          if (!b.streamKey && deferredSessionPath) b.streamKey = deferredSessionPath;
          patchBlockRequestedMetadata(b, metadataTask);
          patchBlockExecutorMetadata(b, metadataTask, readSessionMeta);
          applySubagentIdentity(b, metadataTask, readSessionMeta);

          if (b.streamStatus !== "running") continue;

          const terminalTask = run && run.status !== "pending" ? runTask : task;

          // subagent 完成状态只能由 durable run registry 或 deferred store 的任务终态确认。
          // 子 session 可能有多轮输出，尾部 assistant 文本只能作为 resolved 后的摘要来源。
          if (terminalTask?.status === "aborted") {
            b.streamStatus = "aborted";
            b.summary = terminalTask.reason || "aborted";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "failed") {
            b.streamStatus = "failed";
            b.summary = terminalTask.reason || "failed";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "resolved") {
            b.streamStatus = "done";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);

            const sp = b.streamKey || terminalTask.meta?.sessionPath || null;
            const summary = await readSessionSummary(sp);
            b.summary = summary || (typeof terminalTask.result === "string" ? terminalTask.result.slice(0, 200) : b.summary);
            continue;
          }

          if (run?.status === "pending" && !task) {
            b.streamStatus = "failed";
            b.summary = "历史子会话运行状态不可恢复";
            continue;
          }

          if (!b.streamKey && !run && !task) {
            b.streamStatus = "failed";
            b.summary = "历史子会话链接不可恢复";
          }
        }
      }

      const resolvedSessionPath = queryPath || engine.currentSessionPath || null;
      patchSessionFileLifecycleBlocks(slicedBlocks, engine, resolvedSessionPath);
      const sessionFiles = listSessionRegistryFiles(engine, resolvedSessionPath);

      // 从历史中提取最新 todo 状态：branch-aware，沿当前 leaf 回溯到 root，
      // 只在当前分支路径上找最新合法快照。避免从抛弃的分支取到错误状态。
      const todos = await loadLatestTodosFromSessionFile(queryPath);

      return c.json({ messages, blocks: slicedBlocks, todos, hasMore, sessionFiles });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/sessions/latest-user-message/replay", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path || body?.sessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "session_busy" }, 409);
      }

      const result = await replayLatestUserTurn(engine, {
        sessionPath,
        sourceEntryId: body.sourceEntryId || null,
        clientMessageId: body.clientMessageId || null,
        replacementText: typeof body.text === "string" ? body.text : undefined,
        displayMessage: body.displayMessage || null,
        uiContext: body.uiContext ?? null,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      const status = err.message === "session_busy" ? 409 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  route.post("/sessions/todos/complete", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "Cannot complete todos while session is streaming" }, 409);
      }

      const snapshot = await loadLatestTodoSnapshotFromSessionFile(sessionPath);
      const completedTodos = completeTodoItems(snapshot?.todos || []);
      if (!snapshot?.removed && completedTodos.length > 0) {
        const manager = getWritableSessionManager(engine, sessionPath);
        manager.appendCustomMessageEntry(
          TODO_STATE_CUSTOM_TYPE,
          TODO_COMPLETE_MESSAGE,
          false,
          {
            action: "complete_all",
            source: "user",
            removed: true,
            todos: completedTodos,
          },
        );
      }

      engine.emitEvent?.({ type: "todo_update", todos: [] }, sessionPath);
      return c.json({ ok: true, todos: [] });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 新建 session（可选指定工作目录和 agentId）
  route.post("/sessions/new", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const body = await safeJson(c);
      const { cwd, memoryEnabled, agentId, currentSessionPath: oldSessionPath } = body;
      const workspaceFolders = Array.isArray(body.workspaceFolders)
        ? body.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [];
      const memFlag = memoryEnabled !== false; // 默认 true
      log.log(`新建 session ${JSON.stringify({
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      })}`);

      // 新建前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (oldSessionPath && bm.isRunning(oldSessionPath)) {
        await bm.suspendForSession(oldSessionPath);
      }

      let newSessionPath, newAgentId;
      if (agentId && agentId !== (body.currentAgentId || engine.currentAgentId)) {
        ({ sessionPath: newSessionPath, agentId: newAgentId } = await engine.createSessionForAgent(
          agentId,
          cwd || undefined,
          memFlag,
          undefined,
          { workspaceFolders, visibleInSessionList: true },
        ));
      } else {
        ({ sessionPath: newSessionPath, agentId: newAgentId } = await engine.createSession(
          null,
          cwd || undefined,
          memFlag,
          undefined,
          { workspaceFolders, visibleInSessionList: true },
        ));
      }
      engine.persistSessionMeta();

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = mergeWorkspaceHistory(engine.config.cwd_history, [cwd]);
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      log.log("session 创建完成");
      const response = {
        ok: true,
        path: newSessionPath,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(newSessionPath) || [],
        agentId: newAgentId,
        agentName: engine.getAgent(newAgentId)?.agentName || engine.agentName,
        planMode: engine.planMode,
        permissionMode: engine.permissionMode,
        accessMode: engine.accessMode,
        thinkingLevel: engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 切换 session（支持跨 agent）
  route.post("/sessions/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath, currentSessionPath: oldSessionPath } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      // 运行路径只允许 active desktop session。归档会话必须先 restore。
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      // 切换前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      const suspendPath = oldSessionPath;
      if (suspendPath && bm.isRunning(suspendPath)) {
        await bm.suspendForSession(suspendPath);
      }

      await engine.switchSession(sessionPath);

      // 恢复目标 session 的浏览器（若有）
      await bm.resumeForSession(sessionPath);

      const session = engine.getSessionByPath(sessionPath);

      // 从 sessionPath 解析 agentId，避免依赖 engine 焦点指针的时序
      const switchedAgentId = engine.agentIdFromSessionPath(sessionPath) || engine.currentAgentId;
      const switchedAgent = engine.getAgent(switchedAgentId);

      // switchSession 已同步设置焦点到目标 session。
      // cwd/planMode/model 是 session 级状态，此时读焦点是安全的。
      // memoryEnabled 需要返回 session 自身冻结下来的值，而不是当前
      // master && session 的临时组合态；否则现有 session 的缓存前缀身份
      // 会被全局 gate 混淆。
      // agentId/agentName 已从 sessionPath 解析，不依赖焦点。
      const activeModel = engine.activeSessionModel ?? engine.currentModel;
      const frozenSessionMemoryEnabled =
        switchedAgent?.isSessionMemoryEnabledFor?.(sessionPath) ?? engine.memoryEnabled;
      return c.json({
        ok: true,
        messageCount: session?.messages?.length || 0,
        memoryEnabled: frozenSessionMemoryEnabled,
        planMode: engine.planMode,
        permissionMode: engine.permissionMode,
        accessMode: engine.accessMode,
        thinkingLevel: engine.getSessionThinkingLevel?.(sessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(sessionPath) || [],
        agentId: switchedAgentId,
        agentName: switchedAgent?.agentName || switchedAgentId,
        browserRunning: bm.isRunning(sessionPath),
        browserUrl: bm.currentUrl(sessionPath) || null,
        isStreaming: engine.isSessionStreaming(sessionPath),
        currentModelId: activeModel?.id || null,
        currentModelProvider: activeModel?.provider || null,
        currentModelName: activeModel?.name || null,
        currentModelInput: Array.isArray(activeModel?.input) ? activeModel.input : null,
        currentModelVideo: modelSupportsVideoInput(activeModel),
        currentModelVideoTransport: resolveModelVideoInputTransport(activeModel),
        currentModelVideoTransportSupported: modelSupportsDirectVideoInput(activeModel),
        currentModelReasoning: activeModel?.reasoning ?? null,
        currentModelXhigh: modelSupportsXhigh(activeModel),
        currentModelContextWindow: activeModel?.contextWindow ?? null,
      });
    } catch (err) {
      const errDetail = `${err.message}\n${err.stack || ""}`;
      switchLog.error(`error: ${errDetail}`);
      try { appendFileSync(path.join(engine.hanakoHome, "switch-error.log"), `${new Date().toISOString()}\n${errDetail}\n---\n`); } catch {}
      return c.json({ error: err.message }, 500);
    }
  });

  // 获取所有有浏览器的 session
  route.get("/browser/sessions", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessions());
  });

  // 获取所有有浏览器痕迹的 session 状态（活跃 / 可恢复 / 不可用）
  route.get("/browser/session-states", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessionStates());
  });

  // 关闭指定 session 的浏览器
  route.post("/browser/close-session", async (c) => {
    const body = await safeJson(c);
    const { sessionPath } = body;
    if (!sessionPath) return c.json({ error: "missing sessionPath" });
    const bm = BrowserManager.instance();
    await bm.closeBrowserForSession(sessionPath);
    hub?.eventBus?.emit?.({ type: "browser_status", running: false, url: null }, sessionPath);
    return c.json({ ok: true, sessions: bm.getBrowserSessionStates() });
  });

  // 重命名 session
  route.post("/sessions/rename", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath, title } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof title !== "string" || !title.trim()) {
        return c.json({ error: t("error.missingParam", { param: "title" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      await engine.saveSessionTitle(sessionPath, title.trim());
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 清理过期归档 session
  route.post("/sessions/cleanup", async (c) => {
    try {
      const body = await safeJson(c);
      const { maxAgeDays = 90 } = body;
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let deleted = 0;

      // 遍历所有 agent 的 sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              const activeKey = path.join(agentsDir, agentId, "sessions", f);
              await cleanupSessionLifecycle([activeKey, fp], "parent session deleted");
              await fs.unlink(fp);
              deleteSessionFileSidecarSync(fp);
              deleteSessionSkillSnapshotSync(fp);
              deleted++;
              // 清理 titles.json 孤儿（key = 对应的活跃路径）
              try { await engine.clearSessionTitle(activeKey); } catch {}
            }
          } catch {}
        }
      }

      return c.json({ ok: true, deleted, maxAgeDays });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 列出所有已归档 session（聚合各 agent 的 archived/ 目录）
  route.get("/sessions/archived", async (c) => {
    try {
      const list = await engine.listArchivedSessions();
      return c.json(list);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 归档 session（支持跨 agent）
  route.post("/sessions/archive", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      // archive 是 lifecycle transition，只允许 active desktop session。
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }

      // 确认文件存在
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      // 从 session 路径推导归档目录（同 agent 的 sessions/archived/）
      const destPath = archivedPathForActiveSession(sessionPath);
      const archiveDir = path.dirname(destPath);
      if (await pathExists(destPath)) {
        return c.json({ error: "Archived path already exists" }, 409);
      }
      if (await pathExists(sessionFileSidecarPath(destPath))) {
        return c.json({ error: "Stage file sidecar destination already exists" }, 409);
      }
      await cleanupSessionLifecycle([sessionPath, destPath], "parent session archived");

      // 再从 engine 的 session map 中移除。
      await engine.setSessionPinned(sessionPath, false);
      await engine.closeSession(sessionPath);

      await fs.mkdir(archiveDir, { recursive: true });
      await fs.rename(sessionPath, destPath);
      moveSessionFileSidecarSync(sessionPath, destPath);

      // 将 mtime 置为归档瞬间，使 cleanup 按"归档时间"而非"最后活动时间"判断
      const nowSec = Date.now() / 1000;
      await fs.utimes(destPath, nowSec, nowSec);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 恢复归档 session → 移回 sessions/
  route.post("/sessions/restore", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isArchivedDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      // 必须位于 /archived/ 目录下，防止把活跃 session 当归档路径调用
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const activeDir = path.dirname(archDir);
      const destPath = path.join(activeDir, path.basename(sessionPath));

      // 冲突检测：目标位置已存在，不自动改名（违背"禁止非用户预期的 fallback"）
      try {
        await fs.access(destPath);
        return c.json({ error: "Active path already exists" }, 409);
      } catch { /* 目标不存在，可以恢复 */ }
      if (await pathExists(sessionFileSidecarPath(destPath))) {
        return c.json({ error: "Stage file sidecar destination already exists" }, 409);
      }

      await fs.rename(sessionPath, destPath);
      moveSessionFileSidecarSync(sessionPath, destPath);
      return c.json({ ok: true, restoredPath: destPath });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 永久删除一条归档 session
  route.post("/sessions/archived/delete", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isArchivedDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      const activeKey = activePathForArchivedSession(sessionPath);
      await cleanupSessionLifecycle([activeKey, sessionPath], "parent session deleted");
      try {
        await fs.unlink(sessionPath);
        deleteSessionFileSidecarSync(sessionPath);
        deleteSessionSkillSnapshotSync(sessionPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }
        throw err;
      }
      // 清理 titles.json 孤儿（key = 对应的活跃路径）
      try { await engine.clearSessionTitle(activeKey); } catch {}
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}

function patchSessionFileLifecycleBlocks(blocks, engine, sessionPath) {
  if (!sessionPath) return;
  for (const block of blocks || []) {
    if (!block) continue;
    if (!["file", "artifact", "skill", "screenshot"].includes(block.type)) continue;
    let file = null;
    if (block.fileId && typeof engine?.getSessionFile === "function") {
      file = engine.getSessionFile(block.fileId, { sessionPath });
    }
    if (!file && block.filePath && typeof engine?.getSessionFileByPath === "function") {
      file = engine.getSessionFileByPath(block.filePath, { sessionPath });
    }
    if (!file && block.type === "screenshot" && block.base64 && engine?.hanakoHome && typeof engine?.getSessionFileByPath === "function") {
      try {
        const filePath = browserScreenshotPath(engine.hanakoHome, sessionPath, {
          base64: block.base64,
          mimeType: block.mimeType,
        });
        file = engine.getSessionFileByPath(filePath, { sessionPath });
        if (file) block.type = "file";
      } catch {}
    }
    if (!file) continue;
    const patch = sessionFileLifecycleFields(file, engine);
    Object.assign(block, patch);
    if (block.type === "skill" && block.installedFile) {
      block.installedFile = { ...block.installedFile, ...patch };
    }
  }
}

function listSessionRegistryFiles(engine, sessionPath) {
  if (!sessionPath || typeof engine?.listSessionFiles !== "function") return [];
  return engine.listSessionFiles(sessionPath)
    .map(file => {
      if (typeof engine.serializeSessionFile === "function") return engine.serializeSessionFile(file);
      return serializeSessionFile(file, { runtimeContext: engine?.runtimeContext || null });
    })
    .filter(Boolean);
}

function isMediaGenerationDeferredResult(result) {
  return result?.type === "image-generation" || result?.type === "video-generation";
}

function sessionFileLifecycleFields(file, engine) {
  const serialized = typeof engine?.serializeSessionFile === "function"
    ? engine.serializeSessionFile(file)
    : file;
  const source = serialized || file;
  const fileId = source.fileId || source.id || file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(source.filePath ? { filePath: source.filePath } : {}),
    ...(source.label || source.displayName ? { label: source.label || source.displayName } : {}),
    ...(source.ext !== undefined ? { ext: source.ext } : {}),
    ...(source.mime ? { mime: source.mime } : {}),
    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.storageKind ? { storageKind: source.storageKind } : {}),
    ...(source.status ? { status: source.status } : {}),
    ...(source.missingAt !== undefined ? { missingAt: source.missingAt } : {}),
    ...(source.resource ? { resource: source.resource } : {}),
  };
}
