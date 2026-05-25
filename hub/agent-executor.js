/**
 * AgentExecutor — Agent 会话执行器
 *
 * 使用 Engine 中的长驻 Agent 实例（不再创建临时 Agent），
 * 创建临时 session 执行多轮 prompt，捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 DmRouter 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.js";
import { debugLog } from "../lib/debug-log.js";
import { t } from "../server/i18n.js";
import { createDefaultSettings } from "../core/session-defaults.js";
import { SESSION_PERMISSION_MODES } from "../core/session-permission-mode.js";
import { teardownSessionResources } from "../core/session-teardown.js";
import {
  filterAgentPhoneTools,
  getAgentPhoneActiveToolNames,
  getAgentPhonePermissionMode,
  getAgentPhoneSessionDir,
  shouldReuseAgentPhoneSession,
} from "../lib/conversations/agent-phone-session.js";
import {
  ensureAgentPhoneProjection,
  readAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../lib/conversations/agent-phone-projection.js";
import { findModel, requireModelRef } from "../shared/model-ref.js";
import {
  buildSessionPromptSnapshot,
  createPromptSnapshotResourceLoader,
  normalizeSessionPromptSnapshot,
} from "../core/session-prompt-snapshot.js";

function resolveAgentPhoneModel(engine, ctx, agentConfig, modelOverride) {
  if (!modelOverride) return ctx.resolveModel(agentConfig);
  const ref = requireModelRef(modelOverride);
  const found = findModel(engine.availableModels || [], ref.id, ref.provider);
  if (!found) {
    throw new Error(`Agent phone model override not available: ${ref.provider}/${ref.id}`);
  }
  return found;
}

function buildAgentPhonePromptSnapshot(agent, ctx, systemPrompt) {
  return buildSessionPromptSnapshot({
    systemPrompt,
    appendSystemPrompt: ctx.resourceLoader?.getAppendSystemPrompt?.() || [],
    skillsResult: ctx.getSkillsForAgent?.(agent),
    agentsFilesResult: ctx.resourceLoader?.getAgentsFiles?.(),
  });
}

function normalizeToolNames(value) {
  return Array.isArray(value) ? value.filter((name) => typeof name === "string" && name.length > 0) : null;
}

function mergeToolNames(...groups) {
  return [...new Set(
    groups
      .flat()
      .filter((name) => typeof name === "string" && name.length > 0),
  )];
}

function isAgentPhoneEnabled(engine) {
  return engine?.isChannelsEnabled?.() !== false;
}

function assertAgentPhoneEnabled(engine) {
  if (!isAgentPhoneEnabled(engine)) {
    throw new Error("Agent phone is disabled");
  }
}

async function getRuntimeAgent(engine, agentId, reason) {
  await engine.ensureAgentRuntime?.(agentId, {
    priority: "background",
    reason,
  });
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  return agent;
}

/**
 * 以指定 agentId 的身份跑一次临时会话。
 *
 * @param {string} agentId
 * @param {Array<{text: string, capture?: boolean}>} rounds  按序执行的 prompts
 * @param {object} opts
 * @param {import('../core/engine.js').HanaEngine} opts.engine
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sessionSuffix="temp"]
 * @param {string} [opts.systemAppend] - 追加到 system prompt 末尾
 * @param {boolean} [opts.keepSession=false] - 是否保留 session 文件
 * @param {boolean} [opts.noMemory=false] - 不注入记忆，只用 personality
 * @param {boolean} [opts.noTools=false] - 不注入工具
 * @param {boolean} [opts.readOnly=false] - 只读执行权限（保留工具 schema，调用时拦截副作用工具）
 * @returns {Promise<string>}  capture 轮的输出（已去掉 MOOD 块）
 */
export async function runAgentSession(agentId, rounds, { engine, signal, sessionSuffix = "temp", ephemeralDir, systemAppend, keepSession = false, noMemory = false, noTools = false, readOnly = false } = {}) {
  // 1. 从长驻 Map 获取 Agent 实例
  const agent = await getRuntimeAgent(engine, agentId, "agent-session");
  const agentDir = agent.agentDir;

  // 2. 临时 ResourceLoader
  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory 模式：只用 personality（identity + yuan + ishiki），不注入记忆/用户档案等
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // 3. 临时 session
  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = ephemeralDir || path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = SessionManager.create(cwd, sessionDir);

  // 工具模式：noTools = 无工具；readOnly 只影响执行权限，不裁剪 schema。
  let tools, customTools;
  if (noTools) {
    tools = [];
    customTools = [];
  } else {
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
      })
      : agent.tools;
    const permissionMode = readOnly
      ? SESSION_PERMISSION_MODES.READ_ONLY
      : SESSION_PERMISSION_MODES.OPERATE;
    const built = ctx.buildTools(cwd, agentToolsSnapshot, {
      agentDir,
      workspace: engine.getHomeCwd(agentId),
      getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
      getPermissionMode: () => permissionMode,
    });
    tools = built.tools;
    customTools = built.customTools;
  }
  const model = ctx.resolveModel(agent.config);
  const { session } = await createAgentSession({
    cwd,
    sessionManager: tempSessionMgr,
    settingsManager: createDefaultSettings(),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });

  // 4. AbortSignal 连接
  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // 5. 文本捕获
  let capturedText = "";
  let isCapturing = false;
  const unsub = session.subscribe((event) => {
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    }
  });

  debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      await session.prompt(round.text);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await teardownSessionResources({
      session,
      unsub,
      label: `hub.runAgentSession[${agentId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }

  // 6. 清理临时 session 文件（keepSession=true 时保留，供 DM 等场景存档）
  if (!keepSession) {
    const sessionPath = session.sessionManager?.getSessionFile?.();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch {}
    }
  }

  // 7. 去掉 MOOD 块（backtick 和 XML 两种格式，一次过）
  const text = capturedText
    .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*|<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\n*/gi, "")
    .trim();

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}

function storedRelativePath(agentDir, filePath) {
  return path.relative(agentDir, filePath).split(path.sep).join("/");
}

function resolveStoredSessionPath(agentDir, stored) {
  if (!stored || typeof stored !== "string") return null;
  const resolved = path.resolve(agentDir, ...stored.split("/").filter(Boolean));
  const base = path.resolve(agentDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

/**
 * 以 Agent Phone 方式运行可复用会话。
 *
 * 每个 agent + conversation 复用同一个 session 文件；projection 文档记录
 * session file。该函数不删除 session 文件。
 */
export async function runAgentPhoneSession(agentId, rounds, {
  engine,
  signal,
  conversationId,
  conversationType = "channel",
  systemAppend,
  noMemory = false,
  toolMode = "read_only",
  modelOverride = null,
  onActivity,
  onSessionReady,
  emitEvents = false,
  extraCustomTools = [],
  now = new Date(),
} = {}) {
  if (!conversationId) throw new Error("conversationId is required for agent phone session");
  assertAgentPhoneEnabled(engine);

  const agent = await getRuntimeAgent(engine, agentId, "agent-phone-session");
  const agentDir = agent.agentDir;
  await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });

  const ctx = engine.createSessionContext();
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  const currentSystemPrompt = systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;

  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = getAgentPhoneSessionDir(agentDir, conversationId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const projectionPath = await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });
  const projection = readAgentPhoneProjection(projectionPath);
  const promptSnapshot = normalizeSessionPromptSnapshot(projection.meta.promptSnapshot)
    || buildAgentPhonePromptSnapshot(agent, ctx, currentSystemPrompt);
  const tempResourceLoader = createPromptSnapshotResourceLoader(ctx.resourceLoader, promptSnapshot);
  const existingSessionPath = resolveStoredSessionPath(agentDir, projection.meta.phoneSessionFile);
  const refreshNow = now instanceof Date ? now : new Date(now);
  const existingSessionExists = !!(existingSessionPath && fs.existsSync(existingSessionPath));
  const openedExistingSession = shouldReuseAgentPhoneSession({
    meta: projection.meta,
    sessionExists: existingSessionExists,
    now: refreshNow,
  });
  const sessionManager = openedExistingSession && existingSessionPath
    ? SessionManager.open(existingSessionPath, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
    ? agent.getToolsSnapshot({
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    })
    : agent.tools;
  const phonePermissionMode = getAgentPhonePermissionMode(toolMode);
  const built = ctx.buildTools(cwd, agentToolsSnapshot, {
    agentDir,
    workspace: engine.getHomeCwd(agentId),
    getSessionPath: () => sessionManager?.getSessionFile?.() || null,
    getPermissionMode: () => phonePermissionMode,
  });
  const { tools, customTools } = filterAgentPhoneTools(built, { toolMode });
  const sessionCustomTools = [
    ...customTools,
    ...(Array.isArray(extraCustomTools) ? extraCustomTools : []),
  ];
  const storedToolNames = normalizeToolNames(projection.meta.toolNames);
  const invocationCustomToolNames = getAgentPhoneActiveToolNames({
    customTools: Array.isArray(extraCustomTools) ? extraCustomTools : [],
  });
  const activeToolNames = storedToolNames
    ? mergeToolNames(storedToolNames, invocationCustomToolNames)
    : getAgentPhoneActiveToolNames({
      tools,
      customTools: sessionCustomTools,
    });
  const model = resolveAgentPhoneModel(engine, ctx, agent.config, modelOverride);
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    settingsManager: createDefaultSettings(),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools: sessionCustomTools,
  });
  session.setActiveToolsByName?.(activeToolNames);

  const sessionPath = session.sessionManager?.getSessionFile?.();
  const unregisterPhoneAbort = engine.registerAgentPhoneAbortHandler?.(
    () => {
      try { session.abort?.(); } catch {}
    },
    { agentId, conversationId, conversationType, sessionPath: sessionPath || null },
  ) || (() => {});
  if (sessionPath) {
    await updateAgentPhoneProjectionMeta({
      agentDir,
      agentId,
      conversationId,
      conversationType,
      patch: {
        phoneSessionFile: storedRelativePath(agentDir, sessionPath),
        lastPhoneSessionUsedAt: refreshNow.toISOString(),
        phoneSessionStartedAt: openedExistingSession
          ? (projection.meta.phoneSessionStartedAt || refreshNow.toISOString())
          : refreshNow.toISOString(),
        toolMode,
        promptSnapshot,
        toolNames: activeToolNames,
      },
    });
    try { await onSessionReady?.(sessionPath); } catch {}
  }

  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let capturedText = "";
  let isCapturing = false;
  let lastLiveActivity = null;
  const recordLiveActivity = (key, state, summary, details = {}) => {
    if (!isCapturing || lastLiveActivity === key) return;
    lastLiveActivity = key;
    Promise.resolve(onActivity?.(state, summary, details)).catch(() => {});
  };
  const unsub = session.subscribe((event) => {
    if (emitEvents && sessionPath && isCapturing) {
      engine.emitEvent?.({ ...event, isolated: true }, sessionPath);
    }
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "thinking_delta") {
        recordLiveActivity("thinking", "thinking", "正在思考");
      }
      if (sub?.type === "text_delta") {
        recordLiveActivity("composing", "replying", "正在准备回复");
      }
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    } else if (event.type === "tool_execution_start") {
      if (event.toolName === "channel_reply") {
        recordLiveActivity("channel_reply", "replying", "正在发送频道消息");
      } else if (event.toolName === "channel_pass") {
        recordLiveActivity("channel_pass", "no_reply", "正在选择本轮不发言");
      }
    }
  });

  debugLog()?.log("agent-executor", `${agentId} phone session started (${conversationType}:${conversationId}, ${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) {
        capturedText = "";
        lastLiveActivity = null;
      }
      await session.prompt(round.text);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try { unregisterPhoneAbort(); } catch {}
    await teardownSessionResources({
      session,
      unsub,
      label: `hub.runAgentPhoneSession[${agentId}:${conversationId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }

  const text = capturedText
    .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*|<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\n*/gi, "")
    .trim();

  debugLog()?.log("agent-executor", `${agentId} phone done, ${text.length} chars captured`);
  return text;
}
