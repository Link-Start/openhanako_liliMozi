/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createAgentSession, SessionManager, estimateTokens, findCutPoint, generateSummary, refreshSessionModelFromRegistry } from "../lib/pi-sdk/index.js";
import { createDefaultSettings } from "./session-defaults.js";
import { computeHardTruncation } from "./compaction-utils.js";
import { teardownSessionResources } from "./session-teardown.js";
import { evaluateSessionHealth } from "./session-health.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { t, getLocale } from "../server/i18n.js";
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
  legacyAccessModeFromPermissionMode,
  normalizeSessionPermissionMode,
} from "./session-permission-mode.js";
import { findModel } from "../shared/model-ref.js";
import { computeToolSnapshot, DEFAULT_DISABLED_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.js";
import {
  computeRuntimeDisabledToolNames,
  getStableFeatureDisabledToolNames,
  toolNamesFromObjects,
} from "./tool-availability.js";
import { isActiveSessionPath } from "./message-utils.js";
import { formatWorkspaceScopePrompt, normalizeWorkspaceScope } from "../shared/workspace-scope.js";
import { getProviderPromptPatches } from "./provider-prompt-patches.js";
import { prepareVisionInputForTextOnlyModel } from "./vision-prepare.js";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.js";
import { pruneSessionInlineMediaHistory } from "./session-inline-media-prune.js";
import { createVisionContextInjectionExtension } from "./vision-context-injector.js";
import { modelSupportsDirectVideoInput, modelSupportsVideoInput } from "../shared/model-capabilities.js";
import {
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
  resolveThinkingLevelForModel,
} from "./session-thinking-level.js";
import {
  resolveSessionSkillsForRuntime,
  snapshotSkillsForSession,
} from "../lib/skills/session-skill-snapshot.js";
import { SessionListProjectionCache } from "./session-list-projection-cache.js";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
  summarizeCachePrefixContract,
} from "../lib/llm/cache-prefix-contract.js";

const log = createModuleLogger("session");

/** 巡检/定时任务默认工具白名单（"*" = 与 chat 一致，全部放行） */
export const PATROL_TOOLS_DEFAULT = "*";

function cacheContractDebugEnabled() {
  return process.env.HANA_CACHE_CONTRACT_DEBUG === "1";
}

function assertVideoInputSupported(model, videos) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
  if (!modelSupportsDirectVideoInput(model)) {
    throw new Error("current provider does not support direct video input");
  }
}

function buildPromptMediaOptions(opts) {
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
  ];
  if (!media.length) return undefined;
  return {
    images: media,
    ...(opts.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
  };
}

function collectAssistantTextFromMessage(message) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function addUniqueSessionFile(target, file) {
  if (!file || typeof file !== "object") return;
  const key = file.id || file.fileId || file.filePath || file.path || file.realPath || JSON.stringify(file);
  if (target.some((existing) => (
    (existing.id || existing.fileId || existing.filePath || existing.path || existing.realPath || JSON.stringify(existing)) === key
  ))) {
    return;
  }
  target.push(file);
}

function collectSessionFilesFromToolResult(result) {
  const files = [];
  const details = result?.details;
  addUniqueSessionFile(files, details?.sessionFile);
  if (Array.isArray(details?.sessionFiles)) {
    for (const file of details.sessionFiles) addUniqueSessionFile(files, file);
  }
  return files;
}

function toolErrorSummary(event) {
  const toolName = event?.toolName || event?.name || "tool";
  const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
  const message = typeof raw === "string" ? raw : raw?.message || "";
  return message ? `${toolName}: ${message}` : `${toolName}: failed`;
}

function isolatedCompletionError(stopReason, errorMessage) {
  if (!stopReason || stopReason === "stop") return null;
  const message = typeof errorMessage === "string" ? errorMessage : errorMessage?.message;
  if (stopReason === "error") {
    return message || "assistant message ended with stopReason=error";
  }
  if (stopReason === "length") {
    return "assistant message ended with stopReason=length (output limit reached)";
  }
  return `assistant message ended with stopReason=${stopReason}`;
}

const MAX_CACHED_SESSIONS = 20;
const SESSION_PROMPT_SNAPSHOT_VERSION = 1;
const MiB = 1024 * 1024;
const DEFAULT_RUNTIME_PRESSURE_THRESHOLDS = Object.freeze({
  checkDelayMs: 1500,
  minRetainedBytes: 16 * MiB,
  highPayloadBytes: 64 * MiB,
  highRssBytes: 1536 * MiB,
  highExternalBytes: 512 * MiB,
});

function jsonClone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function freezeSkillsResult(value) {
  const next = {
    skills: Array.isArray(value?.skills) ? value.skills : [],
    diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics : [],
  };
  return jsonClone(next, { skills: [], diagnostics: [] });
}

function freezeAgentsFilesResult(value) {
  const next = {
    agentsFiles: Array.isArray(value?.agentsFiles) ? value.agentsFiles : [],
  };
  return jsonClone(next, { agentsFiles: [] });
}

function normalizeMemoryPressureOptions(raw) {
  if (raw === false || raw?.enabled === false) {
    return {
      enabled: false,
      getMemoryUsage: () => process.memoryUsage(),
      thresholds: DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
    };
  }
  return {
    enabled: true,
    getMemoryUsage: typeof raw?.getMemoryUsage === "function"
      ? raw.getMemoryUsage
      : () => process.memoryUsage(),
    thresholds: {
      ...DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
      ...(raw?.thresholds || {}),
    },
  };
}

function estimateSessionRuntimeRetainedBytes(session) {
  const seen = new WeakSet();
  const stateMessages = session?.agent?.state?.messages;
  const messages = Array.isArray(session?.messages)
    ? session.messages
    : Array.isArray(stateMessages)
      ? stateMessages
      : [];
  return estimateRetainedValueBytes(messages, seen, { count: 0 });
}

function estimateRetainedValueBytes(value, seen, budget, depth = 0) {
  if (value == null || depth > 10 || budget.count > 20_000) return 0;
  budget.count += 1;

  if (typeof value === "string") {
    return value.length >= 8192 ? value.length : 0;
  }
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);

  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += estimateRetainedValueBytes(item, seen, budget, depth + 1);
    return total;
  }

  if ((value.type === "image" || value.type === "video") && typeof value.data === "string") {
    total += value.data.length;
  }
  if ((value.type === "image" || value.type === "video") && typeof value.source?.data === "string") {
    total += value.source.data.length;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((value.type === "image" || value.type === "video") && (key === "data" || key === "source")) {
      continue;
    }
    total += estimateRetainedValueBytes(child, seen, budget, depth + 1);
  }
  return total;
}

function normalizePromptSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== SESSION_PROMPT_SNAPSHOT_VERSION) return null;
  if (typeof value.systemPrompt !== "string") return null;
  return {
    version: SESSION_PROMPT_SNAPSHOT_VERSION,
    systemPrompt: value.systemPrompt,
    appendSystemPrompt: normalizeStringArray(value.appendSystemPrompt),
    skillsResult: freezeSkillsResult(value.skillsResult),
    agentsFilesResult: freezeAgentsFilesResult(value.agentsFilesResult),
    ...(typeof value.finalSystemPrompt === "string"
      ? { finalSystemPrompt: value.finalSystemPrompt }
      : {}),
  };
}

function makeBackgroundTaskPrompt(locale) {
  const isZh = String(locale || "").startsWith("zh");
  return isZh
    ? `## 后台任务

派出 subagent 或其他后台任务后：

1. 先继续做手头还没做完的工作，不要立刻停下来等
2. 手头工作做完后，调 check_pending_tasks 查看后台任务状态
3. 如果还有任务未完成，根据任务复杂度自行估算等待时间，调 wait 等待后再查。最多查 2 次，之后不再轮询，告知用户任务仍在后台运行，完成后会自动处理
4. 只有需要你继续处理的后台任务，系统才会以 <hana-background-result> 消息送达结果；媒体生成这类 UI 结果由界面和 Bridge 自动处理，不要等待或主动追问`
    : `## Background Tasks

After dispatching subagent or other background tasks:

1. Continue with any remaining work first — do not stop immediately to wait
2. Once your other work is done, call check_pending_tasks to check status
3. If tasks are still pending, estimate a reasonable wait time based on task complexity, then call wait and check again. Check at most 2 times — after that, stop polling and tell the user the task is still running and will be handled in the background
4. Only background tasks that need your follow-up are delivered via <hana-background-result> messages. Media generation is handled by the UI and Bridge automatically; do not wait for it or ask about it again`;
}

function buildAppendSystemPromptSnapshot({
  baseAppend,
  providerPromptPatches,
  hasDeferredResultStore,
  locale,
  workspaceScope,
}) {
  const parts = [
    ...(Array.isArray(baseAppend) ? baseAppend : []),
    ...(Array.isArray(providerPromptPatches) ? providerPromptPatches : []),
  ];
  if (hasDeferredResultStore) {
    parts.push(makeBackgroundTaskPrompt(locale));
  }
  const workspacePrompt = formatWorkspaceScopePrompt({
    primaryCwd: workspaceScope.primaryCwd,
    workspaceFolders: workspaceScope.workspaceFolders,
    locale,
  });
  if (workspacePrompt) parts.push(workspacePrompt);
  return normalizeStringArray(parts);
}

export class SessionCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   * @param {(cwd: string) => Promise<void>} [deps.onBeforeSessionCreate]
   */
  constructor(deps) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._hibernatedSessionMeta = new Map();
    this._runtimePressureTimers = new Map();
    this._memoryPressure = normalizeMemoryPressureOptions(deps.memoryPressure);
    this._headlessOps = new Set();
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
    this._metaCache = new Map();   // metaPath → { data, ts }
    this._sessionListProjectionCache = deps.sessionListProjectionCache || new SessionListProjectionCache();
    this._pendingPermissionMode = null;
    this._runtimePermissionModeDefault = DEFAULT_SESSION_PERMISSION_MODE;
    this._metaWriteQueue = Promise.resolve();
    this._prePromptAbortControllers = new Map();
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? this._currentSessionPath ?? null;
  }

  // ── Session 创建 / 切换 ──

  async _shouldIncludeLegacyArtifactToolForRestore(agent, sessionPath) {
    if (!sessionPath) return true;
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const raw = await fsp.readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw);
      const metaEntry = meta[path.basename(sessionPath)];
      if (Array.isArray(metaEntry?.toolNames)) {
        return metaEntry.toolNames.includes("create_artifact");
      }
      return true;
    } catch (err) {
      return err.code === "ENOENT";
    }
  }

  async createSession(sessionMgr, cwd, memoryEnabled = true, model = null, {
    restore = false,
    agent: explicitAgent = null,
    agentId: explicitAgentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    visibleInSessionList = false,
  } = {}) {
    const t0 = Date.now();
    const agent = explicitAgent
      || (explicitAgentId ? this._d.getAgentById?.(explicitAgentId) : null)
      || this._d.getAgent();
    if (!agent) {
      throw new Error("createSession: target agent unavailable");
    }
    const ownerAgentId = explicitAgentId || agent.id || this._d.getActiveAgentId();
    const effectiveCwd = cwd || this._d.getHomeCwd(agent.id) || process.cwd();
    const models = this._d.getModels();
    // restore 模式：不指定 model，让 PI SDK 从 JSONL 恢复（session model 单一数据源）
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (传入: ${cwd || "未指定"})`);

    await this._d.onBeforeSessionCreate?.(effectiveCwd);

    if (!restore && !effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }
    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }
    const sessionPathForMeta = sessionMgr.getSessionFile?.() || null;
    let restoredThinkingLevel = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (typeof metaEntry?.thinkingLevel === "string") {
          restoredThinkingLevel = metaEntry.thinkingLevel;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session thinking level restore failed: ${err.message}`);
        }
      }
    }
    const restoredPromptSnapshot = restore && sessionPathForMeta
      ? await this._readSessionPromptSnapshot(agent, sessionPathForMeta)
      : null;
    const restoredPromptModel = restore && !restoredPromptSnapshot
      ? this._resolvePromptModelFromSessionManager(sessionMgr, models)
      : null;
    const promptPatchModel = restoredPromptSnapshot ? null : (effectiveModel || restoredPromptModel);
    const requestedThinkingLevel = normalizeSessionThinkingLevel(
      restore ? (restoredThinkingLevel || this._d.getPrefs().getThinkingLevel()) : this._d.getPrefs().getThinkingLevel(),
    );
    let initialThinkingLevel = normalizeThinkingLevelForModel(requestedThinkingLevel, promptPatchModel);
    let resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
    const providerPromptPatches = promptPatchModel
      ? getProviderPromptPatches(promptPatchModel, {
        reasoningLevel: resolvedThinkingLevel,
        locale: agent.config?.locale || getLocale(),
      })
      : [];
    let workspaceScope = normalizeWorkspaceScope({
      primaryCwd: effectiveCwd,
      workspaceFolders,
    });
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const restoredFolders = meta[path.basename(sessionPathForMeta)]?.workspaceFolders;
        workspaceScope = normalizeWorkspaceScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: restoredFolders,
        });
      } catch {
        // session-meta 可选：读取或解析失败时沿用上面 fresh 算出的 workspaceScope。
      }
    }
    const includeLegacyArtifactTool = restore
      ? await this._shouldIncludeLegacyArtifactToolForRestore(agent, sessionPathForMeta)
      : false;

    // 冻结当前 session 的有效记忆参与态。
    // fresh create: 以"创建当下实际会进入 prompt 前缀的状态"为准（master && session）
    // restore: 以 session-meta 里冻结下来的 memoryEnabled 为准。
    // 这样已有 session 的 prefix 身份不会被后续 master 开关漂移打穿。
    const frozenMemoryEnabled = restore
      ? !!memoryEnabled
      : (agent.memoryMasterEnabled !== false && !!memoryEnabled);
    let restoredExperienceEnabled = false;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        restoredExperienceEnabled = meta[path.basename(sessionPathForMeta)]?.experienceEnabled === true;
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session-meta.json 读取 experienceEnabled 失败: ${err.message}`);
        }
      }
    }
    const agentHasExperienceSwitch = typeof agent.experienceEnabled === "boolean";
    const frozenExperienceEnabled = restore
      ? restoredExperienceEnabled
      : (agentHasExperienceSwitch ? agent.experienceEnabled === true : false);

    // 切换 session 级记忆状态后立即快照 prompt（下方 promptSnapshot）。
    // /rc 冷恢复这类"附着到旧 session"的路径不应污染当前 agent 的运行态，
    // 因此允许在生成快照后把 agent 的 session-memory 状态回滚。
    const creatingAgent = agent;
    const prevSessionMemoryEnabled = creatingAgent.sessionMemoryEnabled;
    creatingAgent.setMemoryEnabled(frozenMemoryEnabled);

    const baseResourceLoader = this._d.getResourceLoader();
    let restoredPermissionMode = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (metaEntry) {
          restoredPermissionMode = normalizeSessionPermissionMode(metaEntry);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    let initialPermissionMode = restore
      ? normalizeSessionPermissionMode(restoredPermissionMode)
      : normalizeSessionPermissionMode(this._pendingPermissionMode || this._getDefaultPermissionMode());
    this._pendingPermissionMode = null;
    let initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
    let initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
    const sessionEntry = {
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      visibleInSessionList: visibleInSessionList === true && !restore,
    }; // pre-populated for resourceLoader proxy

    // 快照当前 system prompt，per-session 隔离。
    // 后续记忆编译、技能变更只影响新对话，已有对话的 prompt 不变（保护 prefix cache）。
    const systemPromptSnapshot = restoredPromptSnapshot?.systemPrompt
      ?? agent.buildSystemPrompt({
        forceMemoryEnabled: frozenMemoryEnabled,
        forceExperienceEnabled: frozenExperienceEnabled,
      });
    const memoryReflectionSnapshot = (!restore && typeof agent.buildMemoryReflectionSnapshot === "function")
      ? agent.buildMemoryReflectionSnapshot({ forceMemoryEnabled: frozenMemoryEnabled })
      : null;
    if (preserveAgentMemoryState) {
      creatingAgent.setMemoryEnabled(prevSessionMemoryEnabled);
    }

    const localeSnapshot = agent.config?.locale || getLocale();
    const skills = this._d.getSkills?.();
    const appendSystemPromptSnapshot = restoredPromptSnapshot?.appendSystemPrompt
      ?? buildAppendSystemPromptSnapshot({
        baseAppend: baseResourceLoader.getAppendSystemPrompt?.() || [],
        providerPromptPatches,
        hasDeferredResultStore: !!this._d.getDeferredResultStore?.(),
        locale: localeSnapshot,
        workspaceScope,
      });
    const rawSkillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ?? (
        skills?.getSkillsForAgent
          ? freezeSkillsResult(skills.getSkillsForAgent(agent))
          : freezeSkillsResult(baseResourceLoader.getSkills?.())
      );
    const skillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ? freezeSkillsResult(restoredPromptSnapshot.skillsResult)
      : freezeSkillsResult(await snapshotSkillsForSession(rawSkillsResultSnapshot, sessionPathForMeta));
    const agentsFilesResultSnapshot = restoredPromptSnapshot?.agentsFilesResult
      ?? freezeAgentsFilesResult(baseResourceLoader.getAgentsFiles?.());
    const promptSnapshotForPersist = restoredPromptSnapshot || {
      version: SESSION_PROMPT_SNAPSHOT_VERSION,
      systemPrompt: systemPromptSnapshot,
      appendSystemPrompt: appendSystemPromptSnapshot,
      skillsResult: skillsResultSnapshot,
      agentsFilesResult: agentsFilesResultSnapshot,
    };

    const sessionPathRef = { current: sessionPathForMeta };
    const targetModelRef = { current: promptPatchModel || effectiveModel || null };
    const warnVisionContextInjection = (entry) => {
      if (typeof entry === "string") {
        log.warn(entry);
        return;
      }
      log.warn(`vision context injection diagnostic: ${JSON.stringify(entry)}`);
    };

    // Vision 辅助注入扩展：只在目标模型需要图片辅助笔记时注入视觉上下文。
    // 注入器由 Hana 持有 session/model 引用，不读取 Pi SDK ctx，避免 restore 后 stale ctx 丢失 sidecar 笔记。
    // 用户当前 UI 视野不再自动注入；需要时由 current_status(ui_context) 显式查询。
    const getEngine = this._d.getEngine;
    const visionAuxiliaryExtension = createVisionContextInjectionExtension({
      path: "hana-desktop-vision-context-injection",
      sessionPathRef,
      targetModelRef,
      getVisionBridge: () => getEngine?.()?.getVisionBridge?.(),
      isVisionAuxiliaryEnabled: () => getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      resolveSessionFile: ({ fileId, filePath, sessionPath }) => {
        const engine = getEngine?.();
        const lookupSessionPath = sessionPath || sessionPathRef.current || null;
        if (fileId) return engine?.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
        if (filePath) return engine?.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
        return null;
      },
      warn: warnVisionContextInjection,
    });

    // Wrap resourceLoader: per-session prompt snapshot + plan mode injection + vision auxiliary extension
    const resourceLoaderProps = {
      getSystemPrompt: {
        value: () => systemPromptSnapshot,
      },
      getExtensions: {
        value: () => {
          const base = baseResourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
          return {
            ...base,
            extensions: [visionAuxiliaryExtension, ...(base.extensions || [])],
          };
        },
      },
      getAppendSystemPrompt: {
        value: () => [...appendSystemPromptSnapshot],
      },
      getSkills: {
        value: () => resolveSessionSkillsForRuntime(skillsResultSnapshot),
      },
      getAgentsFiles: {
        value: () => freezeAgentsFilesResult(agentsFilesResultSnapshot),
      },
    };
    const resourceLoader = Object.create(baseResourceLoader, resourceLoaderProps);

    const toolSnapshotOptions = { forceMemoryEnabled: frozenMemoryEnabled, model: effectiveModel };
    if (agentHasExperienceSwitch) {
      toolSnapshotOptions.forceExperienceEnabled = frozenExperienceEnabled;
    }
    if (includeLegacyArtifactTool) {
      toolSnapshotOptions.includeLegacyArtifactTool = true;
    }
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot(toolSnapshotOptions)
      : agent.tools;
    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(
      effectiveCwd,
      agentToolsSnapshot,
      { workspace: effectiveCwd, workspaceFolders: workspaceScope.workspaceFolders, agentDir: agent.agentDir },
    );
    const sessionOpts = {
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      thinkingLevel: resolvedThinkingLevel,
      resourceLoader,
      tools: sessionTools,
      customTools: sessionCustomTools,
    };
    // 新建 session 传 model；恢复 session 不传，让 PI SDK 从 JSONL 读取（单一数据源）
    if (effectiveModel) sessionOpts.model = effectiveModel;
    const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);
    if (modelFallbackMessage) {
      log.warn(`session model fallback: ${modelFallbackMessage}`);
    }
    const resolvedModel = session.model;
    const actualThinkingLevel = normalizeThinkingLevelForModel(initialThinkingLevel, resolvedModel);
    if (actualThinkingLevel !== initialThinkingLevel) {
      initialThinkingLevel = actualThinkingLevel;
      resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
      session.setThinkingLevel?.(resolvedThinkingLevel);
    }
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${resolvedModel?.name || effectiveModel?.name || "?"}`);

    // 事件转发（附带 agentId，供订阅者按 agent 过滤）
    const sessionPath = session.sessionManager?.getSessionFile?.();
    sessionPathRef.current = sessionPath || sessionPathRef.current || null;
    targetModelRef.current = resolvedModel || targetModelRef.current || null;
    this._session = session;
    this._currentSessionPath = sessionPath || null;
    this._sessionStarted = false;
    if (restore && sessionPath && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPath)];
        if (metaEntry) {
          initialPermissionMode = normalizeSessionPermissionMode(metaEntry);
          initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
          initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
          sessionEntry.permissionMode = initialPermissionMode;
          sessionEntry.accessMode = initialAccessMode;
          sessionEntry.planMode = initialPlanMode;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    const creatingAgentId = ownerAgentId;
    const unsub = session.subscribe((event) => {
      this._d.emitEvent(
        event.agentId ? event : { ...event, agentId: creatingAgentId },
        sessionPath,
      );
    });

    // 存入 map（SessionEntry）— sessionEntry is the same object the resourceLoader proxy references
    const mapKey = sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();

    // ── Tool snapshot for session-tool-isolation (parallels session-model-isolation) ──
    // Three branches:
    //   A. restore=true + meta has toolNames  → replay the snapshot (applied below)
    //   B. restore=true + meta missing        → legacy session, keep all tools
    //   C. restore=false                       → fresh compute from agent config
    //
    // allToolNames must cover the COMPLETE active set: Pi SDK built-ins
    // (read/bash/edit/write/grep/find/ls) from sessionTools + OpenHanako
    // customs + plugin tools from sessionCustomTools. Using only agent.tools
    // would silently drop SDK built-ins and plugin tools when
    // setActiveToolsByName is applied.
    const allToolObjects = [
      ...(sessionTools || []),
      ...(sessionCustomTools || []),
    ];
    const allToolNames = toolNamesFromObjects(allToolObjects);
    const stableRestoreToolNames = toolNamesFromObjects(allToolObjects, {
      includePluginTools: false,
    });
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    const stableFeatureDisabledToolNames = getStableFeatureDisabledToolNames({
      channelsEnabled,
    });
    const runtimeDisabledToolNames = computeRuntimeDisabledToolNames(
      allToolObjects,
      agent.config,
      { agentId: creatingAgentId, restore, channelsEnabled },
      { warn: (msg) => log.warn(msg) },
    );
    const extraDisabledToolNames = [
      ...stableFeatureDisabledToolNames,
      ...runtimeDisabledToolNames,
    ];
    let snapshotToolNames = null;  // null signals "do not call setActiveToolsByName"
    let shouldPersistRestoredToolNames = false;

    if (restore) {
      if (sessionPath) {
        const metaPathForRestore = path.join(agent.sessionDir, "session-meta.json");
        let metaEntry = null;
        try {
          const raw = await fsp.readFile(metaPathForRestore, "utf-8");
          const meta = JSON.parse(raw);
          metaEntry = meta[path.basename(sessionPath)];
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`session-meta read for tool-snapshot restore failed, recomputing from current agent config: ${err.message}`);
          }
        }
        if (metaEntry && Array.isArray(metaEntry.toolNames)) {
          const restoredToolNames = uniqueToolNames(metaEntry.toolNames);
          snapshotToolNames = computeToolSnapshot(restoredToolNames, [], {
            extraDisabled: stableFeatureDisabledToolNames,
          });  // Case A, with current global feature gates enforced
          shouldPersistRestoredToolNames = restoredToolNames.length !== metaEntry.toolNames.length
            || restoredToolNames.some((name, index) => name !== metaEntry.toolNames[index])
            || snapshotToolNames.length !== restoredToolNames.length;
        } else {
          // Legacy sessions created before tool snapshots had no stable tool
          // identity boundary. Establish one on first restore so future plugin
          // or dynamic tool registrations only affect newly created sessions.
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(stableRestoreToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          shouldPersistRestoredToolNames = true;
        }
      }
    } else {
      // Case C. Fresh agents (and agents upgrading from a pre-feature version)
      // have no tools.disabled field — apply DEFAULT_DISABLED_TOOL_NAMES so
      // dm is off by default. Explicit `[]` means "all on"
      // and is preserved via nullish-coalescing rather than `||`.
      const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
      snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
        extraDisabled: extraDisabledToolNames,
      });
    }

    Object.assign(sessionEntry, {
      session,
      agentId: creatingAgentId,
      memoryEnabled: frozenMemoryEnabled,
      experienceEnabled: frozenExperienceEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      workspaceFolders: workspaceScope.workspaceFolders,
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      toolNames: snapshotToolNames,  // null for legacy sessions (Case B), array otherwise
      memoryReflectionSnapshot,
      lastTouchedAt: Date.now(),
      unsub,
    });
    this._sessions.set(mapKey, sessionEntry);
    this._hibernatedSessionMeta.delete(mapKey);

    // Apply tool snapshot (Case A / Case C). Permission mode is a runtime
    // policy and does not change the stable tool schema.
    if (snapshotToolNames !== null) {
      session.setActiveToolsByName(snapshotToolNames);
    }

    if (restoredPromptSnapshot?.finalSystemPrompt) {
      this._applyFinalPromptSnapshot(session, restoredPromptSnapshot.finalSystemPrompt);
    }
    const finalSystemPrompt = this._getFinalSystemPrompt(session);
    const promptSnapshotToWrite = finalSystemPrompt
      ? { ...promptSnapshotForPersist, finalSystemPrompt }
      : promptSnapshotForPersist;
    this._renewCachePrefixContract(mapKey, sessionEntry, restore ? "session_restore" : "new_session");
    this._installCachePrefixGuard(mapKey, sessionEntry);

    // Persist fresh snapshots and repair/establish restored snapshots. Restored
    // legacy sessions with missing toolNames get a baseline on first restore,
    // so later plugin/dynamic tool registrations do not drift into old history.
    // writeSessionMeta is serialized and never rejects; awaiting gives
    // createSession a clean post-return state.
    if (!restore && sessionPath) {
      const metaPatch = {
        memoryEnabled: frozenMemoryEnabled,
        experienceEnabled: frozenExperienceEnabled,
        workspaceFolders: workspaceScope.workspaceFolders,
        permissionMode: initialPermissionMode,
        accessMode: initialAccessMode,
        planMode: initialPlanMode,
        thinkingLevel: initialThinkingLevel,
        promptSnapshot: promptSnapshotToWrite,
      };
      if (memoryReflectionSnapshot) {
        metaPatch.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      if (snapshotToolNames !== null) metaPatch.toolNames = snapshotToolNames;
      await this.writeSessionMeta(sessionPath, metaPatch);
    } else if (restore && sessionPath) {
      const metaPatch = {};
      if (!restoredPromptSnapshot) metaPatch.promptSnapshot = promptSnapshotToWrite;
      if (shouldPersistRestoredToolNames && snapshotToolNames !== null) {
        metaPatch.toolNames = snapshotToolNames;
      }
      if (Object.keys(metaPatch).length > 0) {
        await this.writeSessionMeta(sessionPath, metaPatch);
      }
    }

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // 记忆收尾（fire-and-forget，淘汰场景不阻塞）
        const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        agent?._memoryTicker?.notifySessionEnd(key).catch((err) =>
          log.warn(`LRU 淘汰 ${path.basename(key)}: notifySessionEnd failed: ${err.message}`),
        );
        await this._teardownSessionEntry(entry, key, "lru");
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return { session, sessionPath: sessionPath || mapKey, agentId: creatingAgentId };
  }

  getSessionWorkspaceFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const entry = this._sessions.get(sessionPath) || this._hibernatedSessionMeta.get(sessionPath);
    return Array.isArray(entry?.workspaceFolders) ? [...entry.workspaceFolders] : [];
  }

  async switchSession(sessionPath) {
    // 只接受"对话焦点"路径，拒绝 subagent-sessions/、activity/、.ephemeral/ 等旁路
    // 目录下的 session 文件。一旦这类路径混入焦点指针，listSessions 的占位逻辑会把
    // 它伪造成"新对话"幻影条目（不能归档、重启即消失）。
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`switchSession: path must be in active desktop session agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }

    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 从 session-meta.json 恢复记忆开关（model 由 PI SDK 从 JSONL 恢复，不在此处读取）
    let memoryEnabled = true;
    try {
      const metaPath = path.join(this._d.getAgent().sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      const sessKey = path.basename(sessionPath);
      const metaEntry = meta[sessKey];
      if (metaEntry?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${err.message}`);
      }
    }

    // 如果已在 map 中，切指针
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._sessions.get(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          // fire-and-forget：memory flush 不阻塞 switch。memory.md 由 onCompiled 回调
          // 刷到 agent._systemPrompt，只影响下次新建 session；老 session 用自己创建时的
          // 快照，对后台异步刷新完全透明。
          oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
            log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
          );
        }
      }
      this._session = existing.session;
      this._currentSessionPath = sessionPath;
      existing.lastTouchedAt = Date.now();
      const targetAgent = this._d.getAgentById(existing.agentId) || this._d.getAgent();
      targetAgent.setMemoryEnabled(memoryEnabled);
      return existing.session;
    }

    // 不在 map 中，先触发旧 session 的 memory flush（后台跑），再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._sessions.get(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
          log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
        );
      }
    }
    // #521: 在恢复前扫描会话尾部，若最近 N 条 assistant 大量 stopReason=error
    // 说明用户已经撞到了"反复 empty_stream"循环，给前端发警告事件让 UI 提示用户
    // 新建会话或修复。restore 本身仍然继续，避免破坏用户预期。
    this._emitSessionHealthWarning(sessionPath);

    // 冷启动恢复：model 由 PI SDK 从 session JSONL 恢复（单一数据源），不从 session-meta.json 读
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent: this._d.getAgent(),
      agentId: targetAgentId || this._d.getActiveAgentId(),
    });
    return result.session;
  }

  /** @private 检查 session 健康度并在 unhealthy 时 log + emit 事件，不抛错 */
  _emitSessionHealthWarning(sessionPath) {
    try {
      const health = evaluateSessionHealth(sessionPath);
      if (health.healthy) return;
      log.warn(
        `session restore: ${path.basename(sessionPath)} unhealthy (`
        + `${health.recentErrors}/${health.totalChecked} recent assistant messages had stopReason=error). `
        + `User may need to start a new session — see #521.`
      );
      this._d.emitEvent?.({
        type: "session_unhealthy_warning",
        recentErrors: health.recentErrors,
        totalChecked: health.totalChecked,
      }, sessionPath);
    } catch (err) {
      // 健康度检查不能阻塞 restore，吃掉所有错误
      log.warn(`session health check failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  async prompt(text, opts) {
    if (!this._session) {
      const currentPath = this.currentSessionPath;
      if (!currentPath) throw new Error(t("error.noActiveSessionPrompt"));
      this._session = await this.ensureSessionLoaded(currentPath);
    }
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    const engine = this._d.getEngine?.();
    ({ text, opts } = await prepareVisionInputForTextOnlyModel({
      targetModel: this._session.model,
      text,
      opts,
      sessionPath: sp,
      getVisionBridge: () => engine?.getVisionBridge?.(),
      visionPolicyTarget: engine,
      warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
    }));
    ({ text, opts } = await prepareModelImageInputsForPrompt({ text, opts }));
    assertVideoInputSupported(this._session.model, opts?.videos);
    const promptOpts = buildPromptMediaOptions(opts);
    try {
      await this._session.prompt(text, promptOpts);
    } finally {
      pruneSessionInlineMediaHistory(this._session);
      if (sp) this._scheduleRuntimePressureCheck(sp, "prompt");
    }
    if (sp) {
      const entry = this._sessions.get(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  async abort() {
    const sessionPath = this.currentSessionPath;
    if (sessionPath) return this.abortSession(sessionPath);
    if (!this._session?.isStreaming) return false;

    try {
      this._session.abort()?.catch?.((err) =>
        log.warn(`abort focus session: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort focus session: abort failed: ${err.message}`);
    }
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    return true;
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath, text, opts) {
    this._assertActiveDesktopSessionPath(sessionPath, "promptSession");
    let entry = this._sessions.get(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._sessions.get(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }
    entry.lastTouchedAt = Date.now();
    entry.visibleInSessionList = true;
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const engine = this._d.getEngine?.();
    const abortController = new AbortController();
    this._prePromptAbortControllers.set(sessionPath, abortController);
    try {
      ({ text, opts } = await prepareVisionInputForTextOnlyModel({
        targetModel: entry.session.model,
        text,
        opts,
        sessionPath,
        getVisionBridge: () => engine?.getVisionBridge?.(),
        visionPolicyTarget: engine,
        warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
        signal: abortController.signal,
      }));
      ({ text, opts } = await prepareModelImageInputsForPrompt({
        text,
        opts,
        signal: abortController.signal,
      }));
    } finally {
      if (this._prePromptAbortControllers.get(sessionPath) === abortController) {
        this._prePromptAbortControllers.delete(sessionPath);
      }
    }
    assertVideoInputSupported(entry.session.model, opts?.videos);
    const promptOpts = buildPromptMediaOptions(opts);
    try {
      await entry.session.prompt(text, promptOpts);
    } finally {
      pruneSessionInlineMediaHistory(entry.session);
      this._scheduleRuntimePressureCheck(sessionPath, "prompt_session");
    }
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    agent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath, text) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(text);
    return true;
  }

  async deliverCustomMessage(sessionPath, message, options = {}) {
    if (!sessionPath) throw new Error("deliverCustomMessage: sessionPath is required");
    this._assertActiveDesktopSessionPath(sessionPath, "deliverCustomMessage");
    let entry = this._sessions.get(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._sessions.get(sessionPath);
    }
    if (!entry?.session) {
      throw new Error(`deliverCustomMessage: session not loaded for ${sessionPath}`);
    }
    if (typeof entry.session.sendCustomMessage !== "function") {
      throw new Error("deliverCustomMessage: session does not support custom messages");
    }

    entry.lastTouchedAt = Date.now();
    if (entry.session.isStreaming) {
      await entry.session.sendCustomMessage(message, { deliverAs: "followUp" });
      return { ok: true, mode: "followUp" };
    }

    const triggerTurn = options?.triggerTurn !== false;
    await entry.session.sendCustomMessage(message, { triggerTurn });
    return { ok: true, mode: triggerTurn ? "triggerTurn" : "notifyOnly" };
  }

  recordCustomEntry(sessionPath, customType, data) {
    if (!sessionPath) throw new Error("recordCustomEntry: sessionPath is required");
    if (!customType) throw new Error("recordCustomEntry: customType is required");
    this._assertActiveDesktopSessionPath(sessionPath, "recordCustomEntry");

    const liveManager = this._sessions.get(sessionPath)?.session?.sessionManager;
    if (typeof liveManager?.appendCustomEntry === "function") {
      liveManager.appendCustomEntry(customType, data);
      return { ok: true, mode: "live" };
    }

    const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
    manager.appendCustomEntry(customType, data);
    return { ok: true, mode: "file" };
  }

  async abortSession(sessionPath) {
    const pending = this._prePromptAbortControllers.get(sessionPath);
    if (pending) {
      pending.abort();
      this._prePromptAbortControllers.delete(sessionPath);
      return true;
    }
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    return this._forceReleaseStreamingSession(entry, sessionPath, "abort");
  }

  // ── Mid-session model switch ──

  /**
   * 在已有 session 上切换模型（不创建新 session）。
   * 如果新模型的上下文窗口容不下当前对话，先压缩/截断。
   *
   * @param {string} sessionPath
   * @param {object} newModel - Pi SDK Model 对象
   * @returns {Promise<{ adaptations: string[] }>}
   */
  async switchSessionModel(sessionPath, newModel) {
    this._assertActiveDesktopSessionPath(sessionPath, "switchSessionModel");
    let entry = this._sessions.get(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._sessions.get(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }

    const { session } = entry;

    // 并发 guard
    if (entry._switching) {
      throw new Error("Model switch already in progress for this session");
    }
    if (session.isCompacting) {
      throw new Error("Cannot switch model while compaction is in progress");
    }

    entry._switching = true;
    const adaptations = [];
    const oldModel = session.model;

    try {
      // 估算当前上下文 token 数
      const msgs = session.agent?.state?.messages || [];
      const usage = session.getContextUsage?.();
      let currentTokens = usage?.tokens;
      if (currentTokens == null) {
        // fallback: 逐消息估算
        currentTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0);
      }

      const effectiveWindow = Math.floor(newModel.contextWindow * 0.9) - 4000;

      if (currentTokens > effectiveWindow) {
        // 预检：最后一轮对话是否本身就超窗口（此时 compact/truncate 都救不了）
        const lastUserIdx = msgs.findLastIndex(m => m.role === "user");
        if (lastUserIdx >= 0) {
          const lastTurnTokens = msgs.slice(lastUserIdx).reduce((s, m) => s + estimateTokens(m), 0);
          if (lastTurnTokens > effectiveWindow) {
            throw new Error("当前对话无法适配目标模型的上下文窗口");
          }
        }

        // 尝试压缩
        try {
          await this._compactWithModel(session, effectiveWindow, oldModel);
          adaptations.push("compacted");
        } catch (compactErr) {
          log.warn(`compactWithModel failed, falling back to hard truncate: ${compactErr.message}`);
          // 压缩失败，尝试硬截断
          try {
            await this._hardTruncate(session, effectiveWindow);
            adaptations.push("truncated");
          } catch (truncErr) {
            throw new Error(`Failed to fit context into new model window: ${truncErr.message}`);
          }
        }

        // 终极检查：压缩/截断后仍然超窗口则拒绝
        const postMsgs = session.agent.state.messages;
        const postTokens = postMsgs.reduce((sum, m) => sum + estimateTokens(m), 0);
        if (postTokens > effectiveWindow) {
          throw new Error(
            `Context still exceeds new model window after adaptation (${postTokens} > ${effectiveWindow})`
          );
        }
      }

      // 执行模型切换
      await session.setModel(newModel);
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;
      const models = this._d.getModels();
      const currentThinkingLevel = this.getSessionThinkingLevel(sessionPath);
      const nextThinkingLevel = normalizeThinkingLevelForModel(currentThinkingLevel, newModel);
      entry.thinkingLevel = nextThinkingLevel;
      session.setThinkingLevel?.(models?.resolveThinkingLevel?.(nextThinkingLevel) || nextThinkingLevel);
      this.writeSessionMeta(sessionPath, { thinkingLevel: nextThinkingLevel });
      this._renewCachePrefixContract(sessionPath, entry, "model_switch");

      return { adaptations, thinkingLevel: nextThinkingLevel };
    } finally {
      entry._switching = false;
    }
  }

  /**
   * 用 LLM 生成摘要来压缩对话历史（为 model switch 准备窗口）。
   * @private
   */
  async _compactWithModel(session, effectiveWindow, model) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();

    // keepRecentTokens = effectiveWindow：保留尽可能多的近期上下文
    const keepRecentTokens = effectiveWindow;

    // 找到有 message 的 entry 的范围
    const messageEntries = pathEntries.filter(e => e.type === "message");
    if (messageEntries.length < 2) {
      throw new Error("Not enough messages to compact");
    }

    // findCutPoint 操作的是 JSONL path entries
    const startIndex = 0;
    const endIndex = pathEntries.length;
    const cutResult = findCutPoint(pathEntries, startIndex, endIndex, keepRecentTokens);

    const { firstKeptEntryIndex, turnStartIndex, isSplitTurn } = cutResult;

    // split-turn 时使用 turnStartIndex 避免 assistant 与 user prompt 分离
    const effectiveCutIndex = isSplitTurn ? turnStartIndex : firstKeptEntryIndex;

    if (effectiveCutIndex <= 0) {
      throw new Error("Cut point at beginning — nothing to compact");
    }

    // 收集要摘要的消息（从 pathEntries[i].message，非 agent.state.messages）
    const messagesToSummarize = [];
    for (let i = 0; i < effectiveCutIndex; i++) {
      if (pathEntries[i].type === "message" && pathEntries[i].message) {
        messagesToSummarize.push(pathEntries[i].message);
      }
    }

    if (messagesToSummarize.length === 0) {
      throw new Error("No messages to summarize before cut point");
    }

    // 链接之前的 compaction summary
    let previousSummary;
    for (const entry of pathEntries) {
      if (entry.type === "compaction" && entry.summary) {
        previousSummary = entry.summary;
      }
    }

    // 获取 API key
    const models = this._d.getModels();
    const auth = await models.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Auth failed for model ${model.id}: ${auth.error}`);
    }
    if (!auth.apiKey) {
      throw new Error(`No API key for provider ${model.provider}`);
    }

    // 计算压缩前 token 数
    const tokensBefore = messagesToSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);

    // 保留 token 数给摘要本身
    const reserveTokens = 4000;

    // 生成摘要
    const summary = await generateSummary(
      messagesToSummarize,
      model,
      reserveTokens,
      auth.apiKey,
      auth.headers,
      undefined,        // signal
      undefined,        // customInstructions
      previousSummary,
    );

    // firstKeptEntryId 是要保留的第一个 entry 的 id
    const firstKeptEntryId = pathEntries[effectiveCutIndex].id;

    // 持久化
    sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, {});

    // 重建上下文
    const ctx = sm.buildSessionContext();
    session.agent.replaceMessages(ctx.messages);
  }

  /**
   * 硬截断对话历史（无 API 调用，用固定文本作为摘要）。
   * @private
   */
  async _hardTruncate(session, effectiveWindow) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();

    const result = computeHardTruncation(pathEntries, effectiveWindow, {
      summary: "[由于模型切换，早期对话历史已被截断]",
      reason: "model-switch-truncation",
    });
    if (!result) {
      throw new Error("Cannot hard-truncate: not enough messages or cut at beginning");
    }

    sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);

    const ctx = sm.buildSessionContext();
    session.agent.replaceMessages(ctx.messages);
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    return isReadOnlyPermissionMode(this.getPermissionMode());
  }

  _getDefaultPermissionMode() {
    return normalizeSessionPermissionMode(this._runtimePermissionModeDefault);
  }

  _setDefaultPermissionMode(mode) {
    this._runtimePermissionModeDefault = normalizeSessionPermissionMode(mode);
  }

  getPermissionModeDefault() {
    return this._getDefaultPermissionMode();
  }

  getPermissionMode(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return this._pendingPermissionMode || this._getDefaultPermissionMode();
    const entry = this._sessions.get(sessionPath) || this._hibernatedSessionMeta.get(sessionPath);
    return normalizeSessionPermissionMode(entry || { permissionMode: this._getDefaultPermissionMode() });
  }

  getSessionThinkingLevel(sessionPath = this.currentSessionPath) {
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    if (!sessionPath) return fallback;
    const entry = this._sessions.get(sessionPath) || this._hibernatedSessionMeta.get(sessionPath);
    return normalizeSessionThinkingLevel(entry?.thinkingLevel || fallback);
  }

  setSessionThinkingLevel(sessionPath, level) {
    if (!sessionPath) {
      return { ok: false, error: "session thinking level requires sessionPath" };
    }
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session) {
      const meta = this._hibernatedSessionMeta.get(sessionPath);
      if (meta) {
        const nextLevel = normalizeSessionThinkingLevel(level);
        meta.thinkingLevel = nextLevel;
        this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
        return { ok: true, thinkingLevel: nextLevel };
      }
      return { ok: false, error: "session not found", thinkingLevel: this.getSessionThinkingLevel(sessionPath) };
    }
    const models = this._d.getModels();
    const nextLevel = normalizeThinkingLevelForModel(level, entry.session.model);
    entry.thinkingLevel = nextLevel;
    entry.session.setThinkingLevel?.(models.resolveThinkingLevel(nextLevel));
    this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
    return { ok: true, thinkingLevel: nextLevel };
  }

  getAccessMode(sessionPath = this.currentSessionPath) {
    return legacyAccessModeFromPermissionMode(this.getPermissionMode(sessionPath));
  }

  setPendingAccessMode(mode) {
    return this.setPendingPermissionMode(mode);
  }

  setPendingPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    this._setDefaultPermissionMode(nextMode);
    this._pendingPermissionMode = nextMode;
    this._emitPermissionModeChanged(nextMode, null);
    return { ok: true, mode: nextMode, enabled: isReadOnlyPermissionMode(nextMode) };
  }

  _applyPermissionModeToEntry(sessionPath, entry, nextMode) {
    entry.permissionMode = nextMode;
    entry.accessMode = legacyAccessModeFromPermissionMode(nextMode);
    entry.planMode = isReadOnlyPermissionMode(nextMode);
    this.writeSessionMeta(sessionPath, {
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
    });
    this._emitPermissionModeChanged(nextMode, sessionPath);
    return { ok: true, mode: nextMode, enabled: entry.planMode };
  }

  setCurrentSessionPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (!sp) {
      return {
        ok: false,
        error: "current session permission mode requires an active session",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._sessions.get(sp);
    if (!entry) {
      const meta = this._hibernatedSessionMeta.get(sp);
      if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      return {
        ok: false,
        error: "current session not found",
        mode: this.getPermissionMode(sp),
      };
    }
    return this._applyPermissionModeToEntry(sp, entry, nextMode);
  }

  setSessionPermissionMode(sessionPath, mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    if (!sessionPath) {
      return {
        ok: false,
        error: "session permission mode requires sessionPath",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._sessions.get(sessionPath);
    if (!entry) {
      const meta = this._hibernatedSessionMeta.get(sessionPath);
      if (meta) return this._applyPermissionModeToEntry(sessionPath, meta, nextMode);
      return {
        ok: false,
        error: "session not found",
        mode: this.getPermissionMode(sessionPath),
      };
    }
    return this._applyPermissionModeToEntry(sessionPath, entry, nextMode);
  }

  setPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    this._setDefaultPermissionMode(nextMode);
    if (sp) {
      const entry = this._sessions.get(sp);
      if (!entry) {
        const meta = this._hibernatedSessionMeta.get(sp);
        if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      }
      if (!entry) return { ok: false, mode: this.getPermissionMode(sp) };
      return this._applyPermissionModeToEntry(sp, entry, nextMode);
    }

    return this.setPendingPermissionMode(nextMode);
  }

  setAccessMode(mode) {
    return this.setPermissionMode(mode);
  }

  /** Backward-compatible route for the old Plan Mode API. */
  setPlanMode(enabled) {
    return this.setPermissionMode(enabled ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.OPERATE);
  }

  _emitPermissionModeChanged(mode, sessionPath) {
    const normalized = normalizeSessionPermissionMode(mode);
    const readOnly = isReadOnlyPermissionMode(normalized);
    const accessMode = legacyAccessModeFromPermissionMode(normalized);
    this._d.emitEvent({ type: "permission_mode", mode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "access_mode", mode: accessMode, permissionMode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "plan_mode", enabled: readOnly }, sessionPath);
    const label = normalized === SESSION_PERMISSION_MODES.READ_ONLY
      ? "只读"
      : (normalized === SESSION_PERMISSION_MODES.ASK ? "先问" : "操作");
    this._d.emitDevLog(`Permission Mode: ${label}`, "info");
  }

  /**
   * 获取当前焦点 session 的完整模型引用 {id, provider}。
   *
   * 数据源：entry 的 modelId + modelProvider 字段（session 创建和 switchSessionModel
   * 时成对写入）。找不到 provider（意味着 session 未完整初始化）返回 null——
   * 禁止按单 id 降级。
   */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessions.get(sp) || this._hibernatedSessionMeta.get(sp);
    if (!entry?.modelId || !entry?.modelProvider) return null;
    return { id: entry.modelId, provider: entry.modelProvider };
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    let count = 0;
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        if (this._forceReleaseStreamingSession(entry, sp, "abort_all")) count++;
      }
    }
    return count;
  }

  // ── Lifecycle teardown (统一入口) ──

  /**
   * 强制释放一个卡在 streaming 状态的 session。
   *
   * 停止按钮属于控制平面，不能等待 provider stream 自己收尾。这里先把
   * Hanako 侧的 sessionPath 控制权释放出来，再把 SDK abort 和资源清理
   * 丢到后台继续做。旧 session 的事件订阅和 SDK agent 连接会先断开，
   * 避免它之后恢复时把过期 delta 写回同一个前端会话或历史文件。
   *
   * @param {object} entry
   * @param {string} sessionPath
   * @param {string} reason
   * @returns {boolean}
   * @private
   */
  _forceReleaseStreamingSession(entry, sessionPath, reason) {
    if (!entry?.session?.isStreaming) return false;

    const session = entry.session;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    entry.lastTouchedAt = Date.now();

    this._clearRuntimePressureTimer(sessionPath);
    this._hibernatedSessionMeta.delete(sessionPath);
    this._sessions.delete(sessionPath);
    if (this._session === session || this.currentSessionPath === sessionPath) {
      this._session = null;
      this._currentSessionPath = null;
      this._sessionStarted = false;
    }

    const unsub = entry.unsub;
    entry.unsub = null;
    try {
      unsub?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: unsub failed: ${err.message}`);
    }

    this._d.emitEvent?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason,
    }, sessionPath);

    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`);
    }

    try {
      session.dispose?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: session.dispose failed: ${err.message}`);
    }

    this._teardownSessionEntry(entry, sessionPath, reason).catch((err) =>
      log.warn(`forceRelease[${reason}] ${spShort}: teardown failed: ${err.message}`),
    );
    return true;
  }

  /**
   * 释放一个 sessionEntry 的所有资源。
   *
   * 三步契约:
   *   1. emit session_shutdown — 让 SDK 扩展清理 setInterval / store 订阅
   *   2. unsub — 取消 Hanako 层的 session 事件转发
   *   3. session.dispose — 让 SDK 释放 agent 订阅和 event listeners
   *
   * 任何一步失败都 log.warn 并继续下一步, 保证下游资源一定被释放。
   *
   * 契约背景: SDK 的 AgentSession.dispose() 本身不 emit session_shutdown,
   * 消费方必须显式 emit, 否则 deferred-result-ext 的 30 秒 setInterval
   * 永远不会被清理。
   *
   * @param {object} entry - sessionEntry (session, unsub, agentId, ...)
   * @param {string} sessionPath - 用于日志识别
   * @param {string} reason - teardown 原因 (lru / close / close_all / isolated)
   * @private
   */
  async _teardownSessionEntry(entry, sessionPath, reason) {
    if (!entry) return;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    await teardownSessionResources({
      session: entry.session,
      unsub: entry.unsub,
      label: `teardown[${reason}] ${spShort}`,
      warn: (msg) => log.warn(msg),
    });
  }

  _canHibernateSessionRuntime(entry, sessionPath) {
    if (!entry?.session || !sessionPath) return false;
    if (entry.session.isStreaming || entry.session.isCompacting || entry._switching) return false;
    if (this._prePromptAbortControllers.has(sessionPath)) return false;
    const pendingDeferred = this._d.getDeferredResultStore?.()?.listPending?.(sessionPath);
    if (Array.isArray(pendingDeferred) && pendingDeferred.length > 0) return false;
    return true;
  }

  async hibernateSessionRuntime(sessionPath, reason = "memory_pressure") {
    const entry = this._sessions.get(sessionPath);
    if (!entry) return false;
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) return false;

    const isFocus = this._session === entry.session || this.currentSessionPath === sessionPath;
    if (isFocus) this._currentSessionPath = sessionPath;
    this._hibernatedSessionMeta.set(sessionPath, {
      agentId: entry.agentId,
      memoryEnabled: entry.memoryEnabled,
      experienceEnabled: entry.experienceEnabled,
      modelId: entry.modelId,
      modelProvider: entry.modelProvider,
      workspaceFolders: Array.isArray(entry.workspaceFolders) ? [...entry.workspaceFolders] : [],
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
      thinkingLevel: entry.thinkingLevel,
      toolNames: Array.isArray(entry.toolNames) ? [...entry.toolNames] : entry.toolNames,
      contextUsage: entry.session?.getContextUsage?.() || null,
      hibernatedAt: Date.now(),
    });
    await this._teardownSessionEntry(entry, sessionPath, reason);
    this._sessions.delete(sessionPath);
    this._clearRuntimePressureTimer(sessionPath);
    if (isFocus) {
      this._session = null;
    }
    log.log(`session runtime hibernated (${reason}): ${path.basename(sessionPath)}`);
    return true;
  }

  checkRuntimeMemoryPressure(sessionPath, reason = "manual") {
    return this._checkRuntimeMemoryPressure(sessionPath, reason);
  }

  async _checkRuntimeMemoryPressure(sessionPath, reason) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) return { hibernated: false, reason: "not_loaded" };
    if (!this._memoryPressure.enabled) return { hibernated: false, reason: "disabled" };
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) {
      return { hibernated: false, reason: "busy" };
    }

    const retainedBytes = estimateSessionRuntimeRetainedBytes(entry.session);
    const memory = this._readMemoryUsage();
    const thresholds = this._memoryPressure.thresholds;
    const externalBytes = (memory.external || 0) + (memory.arrayBuffers || 0);
    const payloadPressure = retainedBytes >= thresholds.highPayloadBytes;
    const processPressure = memory.rss >= thresholds.highRssBytes || externalBytes >= thresholds.highExternalBytes;
    const shouldHibernate = payloadPressure || (processPressure && retainedBytes >= thresholds.minRetainedBytes);
    if (!shouldHibernate) {
      return { hibernated: false, reason: "below_threshold", retainedBytes, memory };
    }

    const hibernated = await this.hibernateSessionRuntime(sessionPath, `memory_pressure:${reason}`);
    return {
      hibernated,
      reason: hibernated ? "memory_pressure" : "busy",
      retainedBytes,
      memory,
    };
  }

  _readMemoryUsage() {
    try {
      const usage = this._memoryPressure.getMemoryUsage();
      return {
        rss: Number(usage?.rss) || 0,
        heapUsed: Number(usage?.heapUsed) || 0,
        external: Number(usage?.external) || 0,
        arrayBuffers: Number(usage?.arrayBuffers) || 0,
      };
    } catch (err) {
      log.warn(`memory pressure usage read failed: ${err.message}`);
      return { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    }
  }

  _scheduleRuntimePressureCheck(sessionPath, reason = "post_turn") {
    if (!this._memoryPressure.enabled || !sessionPath) return;
    const entry = this._sessions.get(sessionPath);
    if (!entry) return;
    const scheduledSession = entry.session;
    this._clearRuntimePressureTimer(sessionPath);
    const delay = Math.max(0, Number(this._memoryPressure.thresholds.checkDelayMs) || 0);
    const timer = setTimeout(() => {
      this._runtimePressureTimers.delete(sessionPath);
      const current = this._sessions.get(sessionPath);
      if (!current || current.session !== scheduledSession) return;
      this._checkRuntimeMemoryPressure(sessionPath, reason).catch((err) => {
        log.warn(`runtime pressure check failed for ${path.basename(sessionPath)}: ${err.message}`);
      });
    }, delay);
    timer.unref?.();
    this._runtimePressureTimers.set(sessionPath, timer);
  }

  _clearRuntimePressureTimer(sessionPath) {
    const timer = this._runtimePressureTimers.get(sessionPath);
    if (!timer) return;
    clearTimeout(timer);
    this._runtimePressureTimers.delete(sessionPath);
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    this._clearRuntimePressureTimer(sessionPath);
    this._hibernatedSessionMeta.delete(sessionPath);
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sessionPath).catch((err) =>
        log.warn(`closeSession ${path.basename(sessionPath)}: notifySessionEnd failed: ${err.message}`),
      );
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, "close");
      } else {
        await this._teardownSessionEntry(entry, sessionPath, "close");
        this._sessions.delete(sessionPath);
      }

      // 清理该 session 的 pending confirmation
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
      this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    }
    if (sessionPath) {
      try {
        this._d.closeTerminalsForSession?.(sessionPath);
      } catch (err) {
        log.warn(`closeSession ${path.basename(sessionPath)}: close terminals failed: ${err.message}`);
      }
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
      this._currentSessionPath = null;
    }
  }

  async closeAllSessions() {
    for (const sessionPath of this._runtimePressureTimers.keys()) {
      this._clearRuntimePressureTimer(sessionPath);
    }
    // abort all streaming sessions + teardown（记忆收尾由 disposeAll 带超时处理）
    for (const [sessionPath, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, "close_all");
      } else {
        await this._teardownSessionEntry(entry, sessionPath, "close_all");
      }
      // closeAll 只卸载运行时 sidecar，不代表删除 session。
      // pending confirmation 必须 abort；后台任务结果由 DeferredResultCoordinator
      // 按 sessionPath 持久投递，closeAll 只卸载 runtime，不应清掉 pending。
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    }
    try {
      this._d.closeAllTerminals?.();
    } catch (err) {
      log.warn(`closeAllSessions: close terminals failed: ${err.message}`);
    }
    this._sessions.clear();
    this._hibernatedSessionMeta.clear();
    this._session = null;
    this._currentSessionPath = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  /**
   * Provider 配置变更后，强制所有 active session 从 ModelRegistry 重新解析
   * 当前 model 对象。
   *
   * 必要性：Pi SDK 把 baseUrl 烤在 model 对象字段里，session 持的是创建时
   * 的对象引用。Hanako 这边 ModelRegistry.refresh() 之后会重建模型对象，
   * 但 session 还指向旧对象——下一个 turn 仍用旧 baseUrl 发请求。
   * 本方法由 engine.onProviderChanged() 触发。
   */
  refreshAllSessionsModels() {
    for (const [sessionPath, entry] of this._sessions) {
      try {
        refreshSessionModelFromRegistry(entry.session);
        this._renewCachePrefixContract(sessionPath, entry, "provider_refresh");
      } catch (err) {
        log.warn(`refreshAllSessionsModels: ${err.message}`);
      }
    }
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  getSessionContextUsage(sessionPath) {
    if (!sessionPath) return null;
    const live = this._sessions.get(sessionPath)?.session?.getContextUsage?.();
    if (live) return live;
    return this._hibernatedSessionMeta.get(sessionPath)?.contextUsage || null;
  }

  _assertActiveDesktopSessionPath(sessionPath, operation) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`${operation}: path must be an active desktop session under agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
  }

  isRunnableSessionPath(sessionPath) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) return false;
    if (this._sessions.has(sessionPath) || this._hibernatedSessionMeta.has(sessionPath)) return true;
    try {
      return fs.existsSync(sessionPath);
    } catch {
      return false;
    }
  }

  /**
   * 确保 sessionPath 已加载进 _sessions cache，但**不改 this._session（UI 焦点）**。
   *
   * 供 /rc 接管态使用：bridge 端操作桌面 session 时，该 session 可能未被
   * UI 打开过（不在 cache 里）。switchSession 会切焦点 + flush 旧 session，
   * 副作用太重。此方法走 createSession 的 cold-load 路径后回滚 this._session 指针，
   * 保证 UI 焦点和内存态不受影响。
   *
   * 幂等：已缓存则直接返回，刷新 lastTouchedAt。
   *
   * @param {string} sessionPath
   * @returns {Promise<object>} AgentSession 实例
   */
  async ensureSessionLoaded(sessionPath) {
    this._assertActiveDesktopSessionPath(sessionPath, "ensureSessionLoaded");
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (!targetAgentId) {
      throw new Error(`ensureSessionLoaded: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById(targetAgentId);
    if (!agent) {
      throw new Error(`ensureSessionLoaded: agent "${targetAgentId}" not found`);
    }

    // memoryEnabled 从 meta 恢复（跟 switchSession 同一份 meta 数据源）
    let memoryEnabled = true;
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      const sessKey = path.basename(sessionPath);
      if (meta[sessKey]?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`ensureSessionLoaded: session-meta.json read failed: ${err.message}`);
      }
    }

    // 保存焦点：createSession 副作用会设 this._session / _sessionStarted，
    // /rc 这类纯 attach 路径结束后必须完整回滚，避免污染桌面 UI 的当前会话态。
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    try {
      // #521: attach 路径同样要做健康度评估，否则 bridge / RC 自动恢复时也会反复失败
      this._emitSessionHealthWarning(sessionPath);
      const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
      const cwd = sessionMgr.getCwd?.() || undefined;
      await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
        restore: true,
        agent,
        agentId: targetAgentId,
        preserveAgentMemoryState: true,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
    }

    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(`ensureSessionLoaded: session not in cache after createSession`);
    if (entry.agentId !== targetAgentId) {
      throw new Error(`ensureSessionLoaded: restored agentId mismatch (${entry.agentId} !== ${targetAgentId})`);
    }
    return entry.session;
  }

  isSessionStreaming(sessionPath) {
    return this._prePromptAbortControllers.has(sessionPath)
      || !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  isSessionSwitching(sessionPath) {
    return !!this._sessions.get(sessionPath)?._switching;
  }

  async abortSessionByPath(sessionPath) {
    return this.abortSession(sessionPath);
  }

  async listSessions() {
    const agents = this._d.listAgents();

    // 并行处理每个 agent，避免串行同步 I/O 阻塞事件循环
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      try { await fsp.access(sessionDir); } catch { return []; }
      try {
        const [sessions, titles, meta] = await Promise.all([
          this._sessionListProjectionCache.list(sessionDir),
          this._loadSessionTitlesFor(sessionDir),
          this._readMetaCached(path.join(sessionDir, "session-meta.json")),
        ]);
        for (const s of sessions) {
          if (titles[s.path]) s.title = titles[s.path];
          s.agentId = agent.id;
          s.agentName = agent.name;
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          s.pinnedAt = typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null;
          // 读取新格式 model:{id,provider}；老格式（只有 modelId）视为无 provider，
          // 调用方必须接受 modelProvider 可能为 null。
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = null;
          }
        }
        return sessions;
      } catch (err) {
        // 显式日志：之前静默吞错会让用户看到「对话框列表为空」却没有任何线索 (#414)
        log.warn(`listSessions: agent="${agent.id}" sessionDir="${sessionDir}" failed: ${err?.message || err}`);
        return [];
      }
    }));
    const allSessions = perAgent.flat();

    const currentPath = this.currentSessionPath;
    const projectedPaths = new Set(allSessions.map((s) => s.path));
    for (const [sessionPath, entry] of this._sessions) {
      if (projectedPaths.has(sessionPath)) continue;
      if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) continue;
      const shouldExpose =
        entry.visibleInSessionList === true
        || entry.session?.isStreaming === true
        || this._prePromptAbortControllers.has(sessionPath)
        || (sessionPath === currentPath && this._sessionStarted);
      if (!shouldExpose) continue;

      const agent = this._d.getAgentById?.(entry.agentId) || this._d.getAgent();
      allSessions.push({
        path: sessionPath,
        title: null,
        firstMessage: "",
        modified: new Date(entry.lastTouchedAt || Date.now()),
        messageCount: 0,
        cwd: entry.session?.sessionManager?.getCwd?.() || "",
        agentId: entry.agentId || this._d.getActiveAgentId(),
        agentName: agent?.agentName || agent?.name || entry.agentId || null,
        modelId: entry.modelId || null,
        modelProvider: entry.modelProvider || null,
        pinnedAt: null,
      });
      projectedPaths.add(sessionPath);
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    titles[sessionPath] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async setSessionPinned(sessionPath, pinned) {
    const pinnedAt = pinned ? new Date().toISOString() : null;
    await this.writeSessionMeta(sessionPath, { pinnedAt });
    await this._verifySessionPinnedState(sessionPath, pinnedAt);
    return pinnedAt;
  }

  async _verifySessionPinnedState(sessionPath, expectedPinnedAt) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch (err) {
      if (expectedPinnedAt === null && err.code === "ENOENT") return;
      throw new Error(`setSessionPinned: verify failed for ${sessKey}: ${err.message}`);
    }
    const actual = meta[sessKey]?.pinnedAt ?? null;
    if (actual !== expectedPinnedAt) {
      throw new Error(`setSessionPinned: expected pinnedAt=${expectedPinnedAt ?? "null"} for ${sessKey}, got ${actual ?? "null"}`);
    }
  }

  /**
   * 清除指定 session 在 session-titles.json 的标题条目。
   * 供归档永久删除 / cleanup 使用，避免 titles.json 孤儿残留。
   * 文件不存在或 key 不在时为 no-op。
   */
  async clearSessionTitle(sessionPath) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    let raw;
    try {
      raw = await fsp.readFile(titlePath, "utf-8");
    } catch {
      return; // titles.json 不存在
    }
    let titles;
    try { titles = JSON.parse(raw); } catch { return; }
    if (!(sessionPath in titles)) return;
    delete titles[sessionPath];
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  /**
   * 列出所有 agent 的已归档 session（`<agentDir>/sessions/archived/*.jsonl`）。
   * title 的存储 key 仍是活跃路径——从 archived 路径反推活跃路径再查 titles.json。
   */
  async listArchivedSessions() {
    const agents = this._d.listAgents();
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      const archDir = path.join(sessionDir, "archived");
      let files;
      try { files = await fsp.readdir(archDir); } catch { return []; }
      const titles = await this._loadSessionTitlesFor(sessionDir).catch(() => ({}));
      const rows = await Promise.all(files
        .filter((f) => f.endsWith(".jsonl"))
        .map(async (f) => {
          const full = path.join(archDir, f);
          try {
            const stat = await fsp.stat(full);
            const activeKey = path.join(sessionDir, f);
            return {
              path: full,
              title: titles[activeKey] || null,
              archivedAt: stat.mtime.toISOString(),
              sizeBytes: stat.size,
              agentId: agent.id,
              agentName: agent.name,
            };
          } catch {
            return null;
          }
        }));
      return rows.filter(Boolean);
    }));
    const all = perAgent.flat();
    all.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
    return all;
  }

  async getTitlesForPaths(paths) {
    const titles = {};
    for (const p of paths) titles[p] = null;

    const byDir = new Map();
    for (const p of paths) {
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }

    for (const [dir, sessionPaths] of byDir) {
      try {
        const dirTitles = await this._loadSessionTitlesFor(dir);
        for (const sp of sessionPaths) {
          if (dirTitles[sp]) titles[sp] = dirTitles[sp];
        }
      } catch {
        // titles 可选：某个目录的 session-titles.json 缺失/损坏时，该目录下路径保持预设的 null。
      }
    }

    return titles;
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  /** 异步读取 session-meta.json，带 TTL 缓存 */
  async _readMetaCached(metaPath) {
    const cached = this._metaCache.get(metaPath);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return cached.data;
    }
    try {
      const raw = await fsp.readFile(metaPath, "utf-8");
      const data = JSON.parse(raw);
      this._metaCache.set(metaPath, { data, ts: Date.now() });
      return data;
    } catch {
      return {};
    }
  }

  async _readSessionPromptSnapshot(agent, sessionPath) {
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      return normalizePromptSnapshot(meta[path.basename(sessionPath)]?.promptSnapshot);
    } catch {
      return null;
    }
  }

  _resolvePromptModelFromSessionManager(sessionMgr, models) {
    try {
      const ref = sessionMgr?.buildSessionContext?.()?.model;
      if (!ref?.provider || !ref?.modelId) return null;
      return findModel(models.availableModels, ref.modelId, ref.provider);
    } catch (err) {
      log.warn(`restore prompt patch model resolve failed: ${err.message}`);
      return null;
    }
  }

  _getFinalSystemPrompt(session) {
    if (typeof session?._baseSystemPrompt === "string") {
      return session._baseSystemPrompt;
    }
    if (typeof session?.agent?.state?.systemPrompt === "string") {
      return session.agent.state.systemPrompt;
    }
    return null;
  }

  _buildCachePrefixContract(entry, { model = null, context = null } = {}) {
    const session = entry?.session;
    const state = session?.agent?.state;
    const hasContextPrompt = context && Object.prototype.hasOwnProperty.call(context, "systemPrompt");
    return buildLlmContextCachePrefixContract({
      model: model || session?.model || state?.model || null,
      systemPrompt: hasContextPrompt ? context.systemPrompt : (this._getFinalSystemPrompt(session) ?? ""),
      tools: Array.isArray(context?.tools) ? context.tools : (Array.isArray(state?.tools) ? state.tools : []),
    });
  }

  _renewCachePrefixContract(sessionPath, entry, reason, options = {}) {
    if (!entry?.session) return null;
    const contract = this._buildCachePrefixContract(entry, options);
    entry.cachePrefixContract = contract;
    entry.cachePrefixContractRenewReason = reason;
    entry.cachePrefixContractRenewedAt = Date.now();
    entry.cachePrefixContractRequestCount = 0;

    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_renew ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        reason,
        contract: summarizeCachePrefixContract(contract),
      })}`);
    }
    return contract;
  }

  _assertCachePrefixContract(sessionPath, entry, { model = null, context = null } = {}) {
    if (!entry?.session) return null;
    const expected = entry.cachePrefixContract
      || this._renewCachePrefixContract(sessionPath, entry, "late_init", { model, context });
    const actual = this._buildCachePrefixContract(entry, { model, context });
    const diffs = diffCachePrefixContracts(expected, actual);
    if (diffs.length > 0) {
      const record = {
        session: sessionPath ? path.basename(sessionPath) : null,
        renewReason: entry.cachePrefixContractRenewReason || null,
        requestCount: entry.cachePrefixContractRequestCount || 0,
        diffs,
        expected: summarizeCachePrefixContract(expected),
        actual: summarizeCachePrefixContract(actual),
      };
      log.error(`cache_contract_violation ${JSON.stringify(record)}`);
      try {
        this._d.emitEvent?.({
          type: "cache_contract_violation",
          sessionPath,
          diffs,
          expected: summarizeCachePrefixContract(expected),
          actual: summarizeCachePrefixContract(actual),
        }, sessionPath);
      } catch {
        // The provider request must still fail even if UI event delivery fails.
      }
      throw new Error(`Cache prefix contract violated: ${diffs.map((d) => d.field).join(", ")}`);
    }

    entry.cachePrefixContractRequestCount = (entry.cachePrefixContractRequestCount || 0) + 1;
    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_check ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        requestCount: entry.cachePrefixContractRequestCount,
        contract: summarizeCachePrefixContract(actual),
      })}`);
    }
    return actual;
  }

  _installCachePrefixGuard(sessionPath, entry) {
    const agent = entry?.session?.agent;
    if (!agent || typeof agent.streamFn !== "function" || entry.cachePrefixGuardInstalled) return;
    const originalStreamFn = agent.streamFn;
    entry.cachePrefixGuardInstalled = true;
    entry.cachePrefixOriginalStreamFn = originalStreamFn;
    agent.streamFn = async (model, context, options) => {
      this._assertCachePrefixContract(sessionPath, entry, { model, context });
      return originalStreamFn.call(agent, model, context, options);
    };
  }

  _applyFinalPromptSnapshot(session, finalSystemPrompt) {
    if (typeof finalSystemPrompt !== "string") return;
    try {
      session._baseSystemPrompt = finalSystemPrompt;
    } catch {
      // session 对象理论上可能 frozen 或 _baseSystemPrompt 带抛错 setter；
      // 容错即可，下面 agent.state.systemPrompt 仍独立尝试写入。
    }
    if (session?.agent?.state && typeof session.agent.state === "object") {
      session.agent.state.systemPrompt = finalSystemPrompt;
    }
  }

  /** session-meta 写入后清除对应缓存 */
  invalidateMetaCache(metaPath) {
    this._metaCache.delete(metaPath);
  }

  /**
   * Single entry point for all session-meta.json writes. Both the memory-toggle
   * path (persistSessionMeta) and the tool-snapshot path (createSession) go
   * through this method. Writes are serialized via a promise chain to prevent
   * RMW races where two concurrent writers would each read stale meta and
   * clobber the other's fields on write-back.
   *
   * @param {string} sessionPath - absolute path to the session .jsonl file
   * @param {object} partial - fields to merge into meta[basename(sessionPath)]
   * @returns {Promise<void>} Resolves after this write (and any writes queued
   *   before it) has been attempted. I/O failures are logged and swallowed
   *   internally — the returned promise never rejects.
   */
  writeSessionMeta(sessionPath, partial) {
    const next = () => this._doWriteSessionMeta(sessionPath, partial);
    // Chain on both success and failure branches so a failed write does not
    // poison the queue — the next write still runs.
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  async _doWriteSessionMeta(sessionPath, partial) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
        } catch {
          // file missing or parse error → start fresh
        }
        meta[sessKey] = {
          ...meta[sessKey],
          ...partial,
        };
        // model is owned by PI SDK via session JSONL — keep session-meta clean
        delete meta[sessKey].model;
        delete meta[sessKey].modelId;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
        this.invalidateMetaCache(metaPath);
        return;
      } catch (err) {
        if (attempt === 0) {
          // 首次写失败可能因父目录缺失：best-effort 补建后由下一轮 attempt 重试 writeFile。
          // mkdir 自身失败（如目录已存在）不影响重试，吞掉即可。
          try { await fsp.mkdir(path.dirname(metaPath), { recursive: true }); } catch {}
        } else {
          log.warn(`writeSessionMeta failed for ${sessKey}: ${err.message}`);
        }
      }
    }
  }

  _sessionMetaPathFor(sessionPath) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    return path.join(sessionDir, "session-meta.json");
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        // migration #5 后 models.chat 必为 {id, provider}；半成品或字符串视为未配置
        const chatRef = agentConfig?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定完整 models.chat，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, ref.id, ref.provider);
        if (!found) {
          // 模型在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${ref.provider}/${ref.id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          log.error(`[resolveModel] 找不到模型 "${ref.provider}/${ref.id}"。availableModels=[${available}]`);
          throw new Error(t("error.resolveModelNotAvailable", { id: `${ref.provider}/${ref.id}` }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile, agentId) {
    const agent = agentId ? this._d.getAgentById(agentId) : this._d.getAgent();
    if (!agent) return null;
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.mkdirSync(agent.sessionDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile} (agent=${agent.id})`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  /**
   * 隔离执行：在独立 session 中执行 prompt（原子操作）。
   *
   * opts:
   *   agentId, cwd, model, persist (string 目录路径 | falsy),
   *   toolFilter, builtinFilter, extraCustomTools, signal,
   *   fileReadSessionPaths (string[] = parent session SessionFile scopes inherited as read-only),
   *   subagentContext (true = 走 subagent 专用 prompt：跳过记忆三段和团队名单),
   *   emitEvents (true 时将 session 事件转发到 EventBus),
   *   onSessionReady (sessionPath => void) 回调，session 创建后、prompt 执行前触发
   */
  async executeIsolated(prompt, opts = {}) {
    let targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }
    if (typeof this._d.ensureAgentRuntime === "function") {
      const ensured = await this._d.ensureAgentRuntime(targetAgent.id, {
        priority: opts.agentId ? "background" : "foreground",
        reason: "executeIsolated",
      });
      if (ensured) targetAgent = ensured;
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.hasAnyRunning;
    const opId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._headlessOps.add(opId);
    if (this._headlessOps.size === 1) bm.setHeadless(true);
    let tempSessionMgr;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        // 临时 session 文件清理 best-effort：删不掉（如已被删/权限）不应让 isolated 执行失败。
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || path.join(targetAgent.agentDir, '.ephemeral');
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
      const workspaceSourceSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
        ? opts.parentSessionPath
        : this.currentSessionPath;
      const inheritedWorkspaceFolders = Array.isArray(opts.workspaceFolders)
        ? opts.workspaceFolders
        : this.getSessionWorkspaceFolders(workspaceSourceSessionPath);
      const execWorkspaceScope = normalizeWorkspaceScope({
        primaryCwd: execCwd,
        workspaceFolders: inheritedWorkspaceFolders,
      });
      const fileReadSessionPaths = Array.isArray(opts.fileReadSessionPaths)
        ? opts.fileReadSessionPaths.filter((sp) => typeof sp === "string" && sp.trim())
        : [];
      const models = this._d.getModels();
      // migration #5 之后 models.chat 必为 {id, provider}；旧裸字符串/缺 provider 对象视为未配置
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const preferredRef = opts.model ? null
        : ((typeof agentPreferredRef === "object" && agentPreferredRef?.id && agentPreferredRef?.provider)
            ? agentPreferredRef : null);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (preferredRef) {
          resolvedModel = findModel(models.availableModels, preferredRef.id, preferredRef.provider);
        }
        if (!resolvedModel) {
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定完整 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (preferredRef && resolvedModel.id !== preferredRef.id) {
          log.log(`[executeIsolated] 模型 "${preferredRef.provider}/${preferredRef.id}" 不可用，fallback → ${resolvedModel.provider}/${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const targetAgentToolsSnapshot = typeof targetAgent.getToolsSnapshot === "function"
        ? targetAgent.getToolsSnapshot({
          forceMemoryEnabled: targetAgent.memoryMasterEnabled !== false,
          model: execModel,
          ...(typeof targetAgent.experienceEnabled === "boolean"
            ? { forceExperienceEnabled: targetAgent.experienceEnabled === true }
            : {}),
        })
        : targetAgent.tools;
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgentToolsSnapshot,
        {
          agentDir: targetAgent.agentDir,
          workspace: execCwd,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
          fileReadSessionPaths,
          getPermissionMode: () => SESSION_PERMISSION_MODES.OPERATE,
        },
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // heartbeat 巡检中屏蔽 cron 工具：agent 在巡检里 cron.create 一个 3 分钟任务
      // 会让该任务持续触发后续巡检/活动，看起来像「巡检间隔被破坏」(#398)
      const isHeartbeat = opts.activityType === "heartbeat";
      const heartbeatBlocked = new Set(isHeartbeat ? ["cron"] : []);
      const actCustomTools = patrolAllowed === "*"
        ? allCustomTools.filter(t => !heartbeatBlocked.has(t.name))
        : allCustomTools.filter(t => new Set(patrolAllowed).has(t.name) && !heartbeatBlocked.has(t.name));
      const extraCustomTools = Array.isArray(opts.extraCustomTools)
        ? opts.extraCustomTools.filter(t => t && typeof t.name === "string" && t.name.trim())
        : [];

      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      let isolatedPrompt;
      if (opts.subagentContext) {
        // Subagent 专用 prompt：跳过长期记忆、pinned、记忆规则、团队 agent 名单。
        // 不走 cached systemPrompt getter，因为它返回"完整 prompt"的缓存。
        isolatedPrompt = targetAgent.buildSystemPrompt({ forSubagent: true, cwdOverride: execCwd });
      } else {
        // 非 session 路径（巡检/cron 等）统一用 master 版本的 systemPrompt cache。
        // per-session 开关只管该 session 自己的对话窗口，不影响这里。
        isolatedPrompt = targetAgent.systemPrompt;
      }
      const execResourceLoaderProps = {
        getSystemPrompt: { value: () => isolatedPrompt },
        getAppendSystemPrompt: {
          value: () => {
            const base = resourceLoader.getAppendSystemPrompt?.() || [];
            const workspacePrompt = formatWorkspaceScopePrompt({
              primaryCwd: execWorkspaceScope.primaryCwd,
              workspaceFolders: execWorkspaceScope.workspaceFolders,
              locale: targetAgent.config?.locale || getLocale(),
            });
            return workspacePrompt ? [...base, workspacePrompt] : base;
          },
        },
      };
      if (targetAgent !== agent) {
        execResourceLoaderProps.getSkills = { value: () => skills.getSkillsForAgent(targetAgent) };
      }
      const execResourceLoader = Object.create(resourceLoader, execResourceLoaderProps);

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: resolveThinkingLevelForModel(
          this._d.getPrefs().getThinkingLevel(),
          execModel,
          (level) => models.resolveThinkingLevel(level),
        ),
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: [...actCustomTools, ...extraCustomTools],
      });

      const childSessionPath = session.sessionManager?.getSessionFile?.() || null;

      // 通知调用方 session 已就绪（subagent 用它来后补 streamKey）
      try { opts.onSessionReady?.(childSessionPath); } catch (err) { log.warn(`isolated onSessionReady callback failed: ${err?.message}`); }

      let replyText = "";
      let finalAssistantText = "";
      let finalStopReason = null;
      let finalErrorMessage = null;
      const sessionFiles = [];
      const toolErrors = [];
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalStopReason = event.message.stopReason ?? null;
          finalErrorMessage = event.message.errorMessage || event.message.error || null;
          finalAssistantText = collectAssistantTextFromMessage(event.message) || finalAssistantText;
        }
        if (event.type === "tool_execution_end") {
          if (event.isError) {
            toolErrors.push(toolErrorSummary(event));
          } else {
            for (const file of collectSessionFilesFromToolResult(event.result)) {
              addUniqueSessionFile(sessionFiles, file);
            }
          }
        }
        if (opts.emitEvents && childSessionPath) {
          this._d.emitEvent({ ...event, isolated: true }, childSessionPath);
        }
      });

      // isolated 专用 teardown: 临时 session 不在 _sessions Map 中,
      // 但仍需 emit shutdown + dispose 以避免扩展资源泄漏。幂等:
      // AgentSession.dispose() 基于 _unsubscribeAgent 做重复调用保护。
      const teardownIsolatedSession = async (label) => {
        await teardownSessionResources({
          session,
          unsub,
          label: `executeIsolated[${label}]`,
          warn: (msg) => log.warn(msg),
        });
      };

      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("early_abort");
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("finally");
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;
      const finalReplyText = replyText || finalAssistantText;
      const completionError = isolatedCompletionError(finalStopReason, finalErrorMessage);

      if (!opts.persist && sessionPath) {
        // 非 persist 的临时 session 文件清理 best-effort：删不掉不影响返回结果。
        try { fs.unlinkSync(sessionPath); } catch {}
        return {
          sessionPath: null,
          replyText: finalReplyText,
          error: completionError,
          stopReason: finalStopReason,
          sessionFiles,
          toolErrors,
        };
      }

      return {
        sessionPath,
        replyText: finalReplyText,
        error: completionError,
        stopReason: finalStopReason,
        sessionFiles,
        toolErrors,
      };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.hasAnyRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model) {
    return createDefaultSettings();
  }
}
