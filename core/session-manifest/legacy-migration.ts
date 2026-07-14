import fs from "fs";
import path from "path";
import {
  readDirectoryLikeDirentsSync,
  readFileLikePathsSync,
} from "../../shared/link-aware-fs.ts";
import { isSessionJsonlFilename } from "../../lib/session-jsonl.ts";
import {
  listAgentPhoneProjectionFiles,
  readAgentPhoneProjection,
  resolveAgentPhoneStoredSessionPath,
} from "../../lib/conversations/agent-phone-projection.ts";
import { normalizeSessionPermissionMode } from "../session-permission-mode.ts";
import { normalizeSessionLocatorPath, sessionLocatorKey } from "./path-normalizer.ts";

const MAX_SKIPPED_DETAILS = 20;
const LOCATOR_REQUIRED_LIFECYCLES = new Set(["active", "archived", "promoted"]);

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function hydrateSessionMetaPayloads(sessionDir, metaPath, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const hydrated: any = {};
  for (const [sessionFile, entry] of Object.entries(data) as [string, any][]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      hydrated[sessionFile] = entry;
      continue;
    }
    const next = { ...entry };
    for (const field of ["promptSnapshot", "memoryReflectionSnapshot"]) {
      const ref = next[field];
      if (
        !ref
        || typeof ref !== "object"
        || Array.isArray(ref)
        || ref.kind !== "session-meta-payload"
        || ref.field !== field
        || typeof ref.path !== "string"
      ) {
        continue;
      }
      try {
        next[field] = JSON.parse(fs.readFileSync(path.join(path.dirname(metaPath), ref.path), "utf-8"));
      } catch {
        delete next[field];
      }
    }
    hydrated[sessionFile] = next;
  }
  return hydrated;
}

function isSessionMetaBackupName(name) {
  return /^session-meta\.oversized\.\d+\.json$/.test(name)
    || /^session-meta\.json\.pre-v\d+\.bak$/.test(name);
}

function readSessionMetaSources(sessionDir) {
  const sources: any[] = [];
  const currentPath = path.join(sessionDir, "session-meta.json");
  const current = readJsonFile(currentPath, null);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    sources.push({
      source: "legacy_session_meta",
      sourcePath: currentPath,
      data: hydrateSessionMetaPayloads(sessionDir, currentPath, current),
    });
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionDir).filter(isSessionMetaBackupName).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const sourcePath = path.join(sessionDir, name);
    const data = readJsonFile(sourcePath, null);
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    sources.push({
      source: "legacy_session_meta_backup",
      sourcePath,
      data: hydrateSessionMetaPayloads(sessionDir, sourcePath, data),
    });
  }
  return sources;
}

function listDirectories(directory) {
  try {
    return readDirectoryLikeDirentsSync(directory).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function listJsonlFiles(directory) {
  try {
    return readFileLikePathsSync(directory, { extension: ".jsonl" })
      .filter((filePath) => isSessionJsonlFilename(path.basename(filePath)))
      .sort();
  } catch {
    return [];
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function storedPathWithin(root, stored, containmentRoot = root) {
  const value = text(stored);
  if (!value) return null;
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, ...value.split(/[\\/]+/).filter(Boolean));
  if (!pathIsInside(containmentRoot, candidate)) return null;
  return candidate;
}

function jsonFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function capabilityEntry(value) {
  const source = record(value) || {};
  const entry: any = {};
  if (Array.isArray(source.toolNames)) entry.toolNames = source.toolNames;
  if (record(source.promptSnapshot)) entry.promptSnapshot = source.promptSnapshot;
  if (Object.prototype.hasOwnProperty.call(source, "capabilityDriftDismissedFingerprint")) {
    entry.capabilityDriftDismissedFingerprint = source.capabilityDriftDismissedFingerprint;
  }
  return entry;
}

function ownerAgentIdForPath(agentsDir, sessionPath) {
  const relative = path.relative(path.resolve(agentsDir), path.resolve(sessionPath));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).filter(Boolean)[0] || null;
}

function isEphemeralSessionPath(sessionPath) {
  return path.resolve(sessionPath).split(path.sep).includes(".ephemeral");
}

function sourceMetaCandidate(source, sourcePath, entry) {
  return record(entry) ? { source, sourcePath, entry: { ...entry } } : null;
}

function discoverSessionRows({ hanaHome, agentsDir }) {
  const rowsByKey = new Map();
  const diagnostics: any[] = [];

  const add = (input: any) => {
    const sessionPath = text(input.sessionPath);
    if (!sessionPath || !isSessionJsonlFilename(path.basename(sessionPath))) return;
    const normalizedPath = normalizeSessionLocatorPath(sessionPath);
    if (!fs.existsSync(normalizedPath)) {
      if (input.indexed === true) {
        diagnostics.push({
          type: "missing_source_locator",
          source: input.source,
          sessionPath: normalizedPath,
          sourcePath: input.sourcePath || null,
        });
      }
      return;
    }
    const key = sessionLocatorKey(normalizedPath);
    const source = text(input.source) || "legacy_layout";
    const priority = Number.isFinite(input.priority) ? input.priority : 10;
    const candidate = sourceMetaCandidate(source, input.sourcePath || normalizedPath, input.metaEntry);
    const previous = rowsByKey.get(key);
    if (!previous) {
      rowsByKey.set(key, {
        sessionPath: normalizedPath,
        ownerAgentId: text(input.ownerAgentId),
        ownerAgentIdSource: source,
        sourceAgentId: text(input.sourceAgentId) || text(input.ownerAgentId),
        domain: input.domain || "desktop",
        kind: input.kind || "chat",
        lifecycle: input.lifecycle || "active",
        provenance: { ...(record(input.provenance) || {}) },
        metaSessionDir: input.metaSessionDir || null,
        titleSessionDir: input.titleSessionDir || null,
        metaCandidates: candidate ? [candidate] : [],
        sources: [source],
        priority,
      });
      return;
    }
    previous.sources = [...new Set([...previous.sources, source])].sort();
    if (candidate && !previous.metaCandidates.some((item) => (
      item.source === candidate.source && item.sourcePath === candidate.sourcePath
    ))) {
      previous.metaCandidates.push(candidate);
    }
    previous.provenance = {
      ...previous.provenance,
      ...(record(input.provenance) || {}),
    };
    if (!previous.metaSessionDir && input.metaSessionDir) previous.metaSessionDir = input.metaSessionDir;
    if (!previous.titleSessionDir && input.titleSessionDir) previous.titleSessionDir = input.titleSessionDir;
    if (priority >= previous.priority) {
      previous.ownerAgentId = text(input.ownerAgentId) || previous.ownerAgentId;
      previous.ownerAgentIdSource = text(input.ownerAgentId) ? source : previous.ownerAgentIdSource;
      previous.sourceAgentId = text(input.sourceAgentId) || previous.sourceAgentId;
      previous.domain = input.domain || previous.domain;
      previous.kind = input.kind || previous.kind;
      previous.lifecycle = input.lifecycle || previous.lifecycle;
      previous.priority = priority;
    }
  };

  for (const sourceAgentId of listDirectories(agentsDir)) {
    const agentDir = path.join(agentsDir, sourceAgentId);
    const sessionDir = path.join(agentDir, "sessions");
    const desktopBase = {
      ownerAgentId: sourceAgentId,
      sourceAgentId,
      domain: "desktop",
      kind: "chat",
      metaSessionDir: sessionDir,
      titleSessionDir: sessionDir,
    };
    for (const sessionPath of listJsonlFiles(sessionDir)) {
      add({ ...desktopBase, sessionPath, lifecycle: "active", source: "desktop_session_layout" });
    }
    for (const sessionPath of listJsonlFiles(path.join(sessionDir, "archived"))) {
      add({ ...desktopBase, sessionPath, lifecycle: "archived", source: "desktop_archived_layout" });
    }

    const bridgeDir = path.join(sessionDir, "bridge");
    for (const role of ["owner", "guests"]) {
      for (const sessionPath of listJsonlFiles(path.join(bridgeDir, role))) {
        const bridgeRole = role === "owner" ? "owner" : "guest";
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "bridge",
          kind: bridgeRole === "owner" ? "bridge_owner" : "bridge_guest",
          lifecycle: "active",
          source: "bridge_session_layout",
          provenance: { createdBy: "bridge", bridgeRole },
        });
      }
    }
    const bridgeIndexPath = path.join(bridgeDir, "bridge-sessions.json");
    const bridgeIndex = readJsonFile(bridgeIndexPath, {});
    for (const [bridgeSessionKey, raw] of Object.entries(record(bridgeIndex) || {})) {
      const entry: any = typeof raw === "string" ? { file: raw } : record(raw);
      const sessionPath = storedPathWithin(bridgeDir, entry?.file, bridgeDir);
      if (!sessionPath) continue;
      const root = path.relative(bridgeDir, sessionPath).split(path.sep)[0];
      const bridgeRole = entry.role === "guest" || root === "guests" ? "guest" : "owner";
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "bridge",
        kind: bridgeRole === "owner" ? "bridge_owner" : "bridge_guest",
        lifecycle: "active",
        source: "legacy_bridge_index",
        sourcePath: bridgeIndexPath,
        indexed: true,
        priority: 60,
        metaEntry: capabilityEntry(entry),
        provenance: {
          createdBy: "bridge",
          bridgeSessionKey,
          bridgeRole,
          ...(text(entry.platform) ? { platform: text(entry.platform) } : {}),
          ...(text(entry.chatType) ? { chatType: text(entry.chatType) } : {}),
        },
      });
    }

    const activityDir = path.join(agentDir, "activity");
    for (const sessionPath of listJsonlFiles(activityDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "activity",
        kind: "activity",
        lifecycle: "active",
        source: "activity_session_layout",
        metaSessionDir: sessionDir,
        provenance: { createdBy: "activity" },
      });
    }
    const activitiesPath = path.join(agentDir, "desk", "activities.json");
    const activities = readJsonFile(activitiesPath, []);
    for (const entry of Array.isArray(activities) ? activities : []) {
      const sessionPath = storedPathWithin(activityDir, entry?.sessionFile, activityDir);
      if (!sessionPath) continue;
      add({
        sessionPath,
        ownerAgentId: text(entry.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "activity",
        kind: "activity",
        lifecycle: "active",
        source: "legacy_activity_index",
        sourcePath: activitiesPath,
        indexed: true,
        priority: 60,
        metaSessionDir: sessionDir,
        provenance: {
          createdBy: "activity",
          ...(text(entry.id) ? { activityId: text(entry.id) } : {}),
          ...(text(entry.type) ? { activityType: text(entry.type) } : {}),
        },
      });
    }

    const phoneSessionsDir = path.join(agentDir, "phone", "sessions");
    for (const conversationDir of listDirectories(phoneSessionsDir)) {
      for (const sessionPath of listJsonlFiles(path.join(phoneSessionsDir, conversationDir))) {
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "phone",
          kind: "phone_conversation",
          lifecycle: "active",
          source: "phone_session_layout",
          provenance: { createdBy: "agent_phone" },
        });
      }
    }
    const phoneRuntimeDir = path.join(agentDir, "phone", "session-runtime");
    for (const runtimePath of jsonFiles(phoneRuntimeDir)) {
      const runtime: any = readJsonFile(runtimePath, null);
      if (!record(runtime)) continue;
      const sessionPath = resolveAgentPhoneStoredSessionPath(agentDir, runtime.phoneSessionFile);
      if (!sessionPath || !pathIsInside(phoneSessionsDir, sessionPath)) continue;
      add({
        sessionPath,
        ownerAgentId: text(runtime.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "phone",
        kind: "phone_conversation",
        lifecycle: "active",
        source: "legacy_phone_runtime",
        sourcePath: runtimePath,
        indexed: true,
        priority: 70,
        metaEntry: capabilityEntry(runtime),
        provenance: {
          createdBy: "agent_phone",
          ...(text(runtime.conversationId) ? { conversationId: text(runtime.conversationId) } : {}),
          ...(text(runtime.conversationType) ? { conversationType: text(runtime.conversationType) } : {}),
        },
      });
    }
    for (const projectionPath of listAgentPhoneProjectionFiles(agentDir).sort()) {
      const projection = readAgentPhoneProjection(projectionPath);
      const meta: any = record(projection?.meta);
      const sessionPath = resolveAgentPhoneStoredSessionPath(agentDir, meta?.phoneSessionFile);
      if (!sessionPath || !pathIsInside(phoneSessionsDir, sessionPath)) continue;
      add({
        sessionPath,
        ownerAgentId: text(meta.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "phone",
        kind: "phone_conversation",
        lifecycle: "active",
        source: "legacy_phone_projection",
        sourcePath: projectionPath,
        indexed: true,
        priority: 65,
        metaEntry: capabilityEntry(meta),
        provenance: {
          createdBy: "agent_phone",
          ...(text(meta.conversationId) ? { conversationId: text(meta.conversationId) } : {}),
          ...(text(meta.conversationType) ? { conversationType: text(meta.conversationType) } : {}),
        },
      });
    }

    const subagentDir = path.join(agentDir, "subagent-sessions");
    for (const sessionPath of listJsonlFiles(subagentDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source: "legacy_subagent_session_layout",
        metaSessionDir: subagentDir,
        provenance: { createdBy: "subagent" },
      });
    }
    const directDir = path.join(subagentDir, "direct");
    for (const sessionPath of listJsonlFiles(directDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source: "subagent_session_layout",
        metaSessionDir: directDir,
        provenance: { createdBy: "subagent", threadKind: "direct" },
      });
    }

    const workflowDir = path.join(agentDir, "workflow-sessions");
    for (const runId of listDirectories(workflowDir)) {
      const runDir = path.join(workflowDir, runId);
      for (const sessionPath of listJsonlFiles(runDir)) {
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "subagent",
          kind: "subagent_child",
          lifecycle: "active",
          source: "workflow_session_layout",
          metaSessionDir: runDir,
          provenance: { createdBy: "subagent", parentRunId: runId, threadKind: "workflow_node" },
        });
      }
    }
  }

  const addSubagentStoreRecords = (storePath, containerKey, source) => {
    const raw = readJsonFile(storePath, {});
    const entries = record(raw?.[containerKey]) || record(raw) || {};
    for (const [recordId, value] of Object.entries(entries)) {
      const entry: any = record(value);
      if (!entry) continue;
      const sessionPath = storedPathWithin(hanaHome, entry.childSessionPath || entry.sessionPath, hanaHome);
      if (!sessionPath || isEphemeralSessionPath(sessionPath)) continue;
      const sourceAgentId = ownerAgentIdForPath(agentsDir, sessionPath);
      const ownerAgentId = text(entry.executorAgentId) || text(entry.agentId) || sourceAgentId;
      const threadKind = text(entry.threadKind) || text(entry.kind);
      add({
        sessionPath,
        ownerAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source,
        sourcePath: storePath,
        indexed: true,
        priority: source === "legacy_subagent_thread_store" ? 90 : 80,
        metaEntry: entry,
        provenance: {
          createdBy: "subagent",
          ...(text(entry.parentSessionId) ? { parentSessionId: text(entry.parentSessionId) } : {}),
          ...(!text(entry.parentSessionId) && text(entry.parentSessionPath)
            ? { legacyParentSessionPath: text(entry.parentSessionPath) }
            : {}),
          ...(text(entry.parentTaskId) ? { parentRunId: text(entry.parentTaskId) } : {}),
          ...(source === "legacy_subagent_run_store" ? { subagentTaskId: recordId } : {}),
          ...(source === "legacy_subagent_thread_store" ? { threadId: recordId } : {}),
          ...(threadKind ? { threadKind } : {}),
        },
      });
    }
  };
  addSubagentStoreRecords(path.join(hanaHome, "subagent-runs.json"), "runs", "legacy_subagent_run_store");
  addSubagentStoreRecords(path.join(hanaHome, "subagent-threads.json"), "threads", "legacy_subagent_thread_store");

  return {
    sessions: [...rowsByKey.values()],
    diagnostics,
  };
}

export function discoverLegacySessions(opts: any = {}) {
  if (!opts.hanaHome) throw new Error("discoverLegacySessions requires hanaHome");
  const hanaHome = path.resolve(opts.hanaHome);
  const agentsDir = path.resolve(opts.agentsDir || path.join(hanaHome, "agents"));
  return discoverSessionRows({ hanaHome, agentsDir });
}

function hasLegacyPermissionFields(metaEntry) {
  return typeof metaEntry?.permissionMode === "string"
    || typeof metaEntry?.accessMode === "string"
    || typeof metaEntry?.planMode === "boolean";
}

function hasCapabilityFields(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    || (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object")
    || typeof metaEntry?.capabilityDriftDismissedFingerprint === "string"
    || metaEntry?.capabilityDriftDismissedFingerprint === null;
}

function hasExecutorFields(metaEntry) {
  return typeof metaEntry?.executorAgentId === "string"
    || typeof metaEntry?.agentId === "string"
    || typeof metaEntry?.executorAgentNameSnapshot === "string"
    || typeof metaEntry?.executorAgentName === "string"
    || typeof metaEntry?.agentNameSnapshot === "string"
    || typeof metaEntry?.agentName === "string";
}

function normalizeExecutorMetadata(metaEntry: any = {}) {
  const executorAgentId =
    typeof metaEntry.executorAgentId === "string" && metaEntry.executorAgentId.trim()
      ? metaEntry.executorAgentId.trim()
      : typeof metaEntry.agentId === "string" && metaEntry.agentId.trim()
        ? metaEntry.agentId.trim()
        : null;
  const executorAgentNameSnapshot =
    typeof metaEntry.executorAgentNameSnapshot === "string" && metaEntry.executorAgentNameSnapshot.trim()
      ? metaEntry.executorAgentNameSnapshot.trim()
      : typeof metaEntry.executorAgentName === "string" && metaEntry.executorAgentName.trim()
        ? metaEntry.executorAgentName.trim()
        : typeof metaEntry.agentNameSnapshot === "string" && metaEntry.agentNameSnapshot.trim()
          ? metaEntry.agentNameSnapshot.trim()
          : typeof metaEntry.agentName === "string" && metaEntry.agentName.trim()
            ? metaEntry.agentName.trim()
            : null;
  if (!executorAgentId && !executorAgentNameSnapshot) return null;
  return {
    executorAgentId,
    executorAgentNameSnapshot,
    executorMetaVersion: Number.isFinite(metaEntry.executorMetaVersion) ? metaEntry.executorMetaVersion : 1,
  };
}

function toolNameCount(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    ? metaEntry.toolNames.filter((item) => typeof item === "string" && item).length
    : 0;
}

function capabilityScore(metaEntry) {
  if (!hasCapabilityFields(metaEntry)) return 0;
  return toolNameCount(metaEntry) * 1000
    + (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object" ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(metaEntry || {}, "capabilityDriftDismissedFingerprint") ? 10 : 0);
}

function sessionMetaCandidates(metaSources, sessionPath) {
  const sessionFile = path.basename(sessionPath);
  return (metaSources || [])
    .map((source) => {
      const entry = source?.data?.[sessionFile];
      return entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...source, entry }
        : null;
    })
    .filter(Boolean);
}

function selectBestMetaCandidate(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDelta = capabilityScore(b.entry) - capabilityScore(a.entry);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.source === "legacy_session_meta" && b.source !== "legacy_session_meta") return -1;
    if (b.source === "legacy_session_meta" && a.source !== "legacy_session_meta") return 1;
    return String(b.sourcePath || "").localeCompare(String(a.sourcePath || ""));
  })[0] || null;
}

function selectPermissionCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasLegacyPermissionFields(candidate.entry)
  )) || candidates.find((candidate) => hasLegacyPermissionFields(candidate.entry)) || null;
}

function selectCapabilityCandidate(candidates) {
  return selectBestMetaCandidate(candidates.filter((candidate) => hasCapabilityFields(candidate.entry)));
}

function selectExecutorCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasExecutorFields(candidate.entry)
  )) || candidates.find((candidate) => hasExecutorFields(candidate.entry)) || null;
}

function legacyMemoryPolicy(metaEntry) {
  if (metaEntry?.memoryEnabled === true) {
    return { mode: "enabled", inheritedFrom: "legacy_session_meta" };
  }
  if (metaEntry?.memoryEnabled === false) {
    return { mode: "disabled", inheritedFrom: "legacy_session_meta" };
  }
  return { mode: "inherit", inheritedFrom: "agent_default" };
}

function legacyWorkspaceScope(metaEntry) {
  const workspaceScope: any = {};
  if (Array.isArray(metaEntry?.workspaceFolders)) {
    workspaceScope.workspaceFolders = metaEntry.workspaceFolders.filter((item) => typeof item === "string");
  }
  if (Array.isArray(metaEntry?.authorizedFolders)) {
    workspaceScope.authorizedFolders = metaEntry.authorizedFolders.filter((item) => typeof item === "string");
  }
  if (typeof metaEntry?.primaryCwd === "string") {
    workspaceScope.primaryCwd = metaEntry.primaryCwd;
  }
  const mountId = typeof metaEntry?.workspaceMountId === "string"
    ? metaEntry.workspaceMountId
    : (typeof metaEntry?.mountId === "string" ? metaEntry.mountId : null);
  if (mountId) {
    workspaceScope.workspaceMount = {
      mountId,
      ...(typeof metaEntry?.workspaceLabel === "string" ? { label: metaEntry.workspaceLabel } : {}),
    };
  }
  return workspaceScope;
}

function legacyPlugin(metaEntry) {
  const plugin = metaEntry?.plugin && typeof metaEntry.plugin === "object" ? metaEntry.plugin : null;
  if (!plugin) return null;
  return {
    ownerPluginId: typeof plugin.ownerPluginId === "string" ? plugin.ownerPluginId : null,
    kind: typeof plugin.kind === "string" ? plugin.kind : null,
    visibility: typeof plugin.visibility === "string" ? plugin.visibility : "public",
  };
}

function legacyTitleFor(titles, sessionDir, sessionPath) {
  const activePath = path.join(sessionDir, path.basename(sessionPath));
  return titles[sessionPath] || titles[activePath] || titles[path.basename(sessionPath)] || null;
}

function backfillLegacyTitleSessionIdKey(titlesPath, titles, sessionDir, sessionPath, manifest) {
  if (!manifest?.sessionId || !titles || typeof titles !== "object" || Array.isArray(titles)) return;
  if (titles[manifest.sessionId]) return;
  const title = manifest.provenance?.legacyTitle || legacyTitleFor(titles, sessionDir, sessionPath);
  if (typeof title !== "string" || !title.trim()) return;
  titles[manifest.sessionId] = title;
  try {
    fs.writeFileSync(titlesPath, JSON.stringify(titles, null, 2));
  } catch {
    delete titles[manifest.sessionId];
  }
}

function buildLegacyManifestInput({ row, candidates, titles, migratedAt }) {
  const sessionPath = row.sessionPath;
  const sessionDir = row.titleSessionDir || row.metaSessionDir || path.dirname(sessionPath);
  const bestCandidate = selectBestMetaCandidate(candidates);
  const permissionCandidate = selectPermissionCandidate(candidates);
  const metaEntry = bestCandidate?.entry || {};
  const permissionEntry = permissionCandidate?.entry || metaEntry;
  const plugin = legacyPlugin(metaEntry);
  const permissionHasLegacySource = hasLegacyPermissionFields(permissionEntry);
  return {
    sessionPath,
    ownerAgentId: row.ownerAgentId,
    domain: row.domain,
    kind: row.domain === "desktop" ? (plugin?.kind || row.kind || "chat") : row.kind,
    lifecycle: row.lifecycle,
    memoryPolicy: legacyMemoryPolicy(metaEntry),
    permissionModeSnapshot: {
      mode: normalizeSessionPermissionMode(permissionEntry),
      source: permissionHasLegacySource ? permissionCandidate.source : "migration_default",
      capturedAt: migratedAt,
    },
    thinkingLevel: typeof metaEntry?.thinkingLevel === "string" ? metaEntry.thinkingLevel : null,
    pinnedAt: typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null,
    workspaceScope: legacyWorkspaceScope(metaEntry),
    plugin,
    provenance: {
      legacyAgentId: row.sourceAgentId || row.ownerAgentId,
      legacyLifecycle: row.lifecycle,
      legacyTitle: legacyTitleFor(titles, sessionDir, sessionPath),
      ...(record(row.provenance) || {}),
    },
    migration: {
      legacySessionPath: sessionPath,
      legacySessionFileName: path.basename(sessionPath),
      source: "legacy_scan",
      migratedAt,
      legacySources: [...(row.sources || [])].sort(),
    },
    locatorReason: "legacy_scan",
  };
}

function capabilitySnapshotFromCandidate(candidate) {
  const entry = candidate?.entry;
  if (!entry || !hasCapabilityFields(entry)) return null;
  const snapshot: any = {};
  if (Array.isArray(entry.toolNames)) {
    const seen = new Set();
    snapshot.toolNames = entry.toolNames.filter((item) => {
      if (typeof item !== "string" || !item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }
  if (entry.promptSnapshot && typeof entry.promptSnapshot === "object" && !Array.isArray(entry.promptSnapshot)) {
    snapshot.promptSnapshot = entry.promptSnapshot;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "capabilityDriftDismissedFingerprint")) {
    snapshot.capabilityDriftDismissedFingerprint =
      typeof entry.capabilityDriftDismissedFingerprint === "string"
        ? entry.capabilityDriftDismissedFingerprint
        : null;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function shouldReplaceCapabilitySnapshot(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  if (!existingSource.startsWith("legacy_session_meta")) return false;
  const existingScore = (Array.isArray(existing.toolNames) ? existing.toolNames.length : 0) * 1000
    + (existing.promptSnapshot ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(existing, "capabilityDriftDismissedFingerprint") ? 10 : 0);
  return capabilityScore(candidate.entry) > existingScore;
}

function importLegacyCapabilitySnapshot(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getCapabilitySnapshot !== "function" || typeof store.setCapabilitySnapshot !== "function") {
    return;
  }
  const candidate = selectCapabilityCandidate(candidates);
  if (!candidate) return;
  const existing = store.getCapabilitySnapshot(manifest.sessionId);
  if (!shouldReplaceCapabilitySnapshot(existing, candidate)) return;
  const snapshot = capabilitySnapshotFromCandidate(candidate);
  if (!snapshot) return;
  store.setCapabilitySnapshot(manifest.sessionId, snapshot, { source: candidate.source });
}

function shouldReplaceExecutorMetadata(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  return existingSource.startsWith("legacy_session_meta");
}

function importLegacyExecutorMetadata(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getExecutorMetadata !== "function" || typeof store.setExecutorMetadata !== "function") {
    return;
  }
  const candidate = selectExecutorCandidate(candidates);
  if (!candidate) return;
  const existing = store.getExecutorMetadata(manifest.sessionId);
  if (!shouldReplaceExecutorMetadata(existing, candidate)) return;
  const metadata = normalizeExecutorMetadata(candidate.entry);
  if (!metadata) return;
  store.setExecutorMetadata(manifest.sessionId, metadata, { source: candidate.source });
}

function repairPermissionSnapshotFromLegacyMeta(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.setPermissionModeSnapshot !== "function") return manifest;
  if (manifest.permissionModeSnapshot?.source !== "migration_default") return manifest;
  const candidate = selectPermissionCandidate(candidates);
  if (!candidate) return manifest;
  return store.setPermissionModeSnapshot(manifest.sessionId, {
    mode: normalizeSessionPermissionMode(candidate.entry),
    source: candidate.source,
  });
}

function repairExistingLocatorIfNeeded(store, existing, sessionPath) {
  if (!existing?.sessionId) return existing;
  const expectedPath = normalizeSessionLocatorPath(sessionPath);
  if (existing.currentLocator?.path === expectedPath) return existing;
  return store.updateLocator(existing.sessionId, sessionPath, "legacy_scan_repair");
}

function createLegacyRowReader() {
  const metaSourcesByDir = new Map();
  const titlesByDir = new Map();
  return {
    candidates(row) {
      let candidates: any[] = [];
      if (row.metaSessionDir) {
        if (!metaSourcesByDir.has(row.metaSessionDir)) {
          metaSourcesByDir.set(row.metaSessionDir, readSessionMetaSources(row.metaSessionDir));
        }
        candidates = sessionMetaCandidates(metaSourcesByDir.get(row.metaSessionDir), row.sessionPath);
      }
      return [...candidates, ...(row.metaCandidates || [])];
    },
    titleState(row) {
      if (!row.titleSessionDir) return { titlesPath: null, titles: {} };
      if (!titlesByDir.has(row.titleSessionDir)) {
        const titlesPath = path.join(row.titleSessionDir, "session-titles.json");
        titlesByDir.set(row.titleSessionDir, {
          titlesPath,
          titles: readJsonFile(titlesPath, {}),
        });
      }
      return titlesByDir.get(row.titleSessionDir);
    },
  };
}

function expectedManifestInput(row, reader, migratedAt) {
  const candidates = reader.candidates(row);
  const { titles } = reader.titleState(row);
  return {
    candidates,
    input: buildLegacyManifestInput({ row, candidates, titles, migratedAt }),
  };
}

export function auditLegacySessionManifests(opts: any = {}) {
  if (!opts.hanaHome) throw new Error("auditLegacySessionManifests requires hanaHome");
  if (!opts.store) throw new Error("auditLegacySessionManifests requires store");

  const discovery = discoverLegacySessions(opts);
  const reader = createLegacyRowReader();
  const details: any = {
    missing: [],
    missingLocators: [],
    domainMismatches: [],
    ownerMismatches: [],
    lifecycleMismatches: [],
    discoveryWarnings: [...discovery.diagnostics],
  };
  let manifested = 0;

  for (const row of discovery.sessions) {
    let manifest = null;
    try {
      manifest = opts.store.resolveByLocatorPath(row.sessionPath);
    } catch (error) {
      details.missing.push({
        sessionPath: row.sessionPath,
        expectedDomain: row.domain,
        expectedKind: row.kind,
        error: error?.message || String(error),
      });
      continue;
    }
    const { input } = expectedManifestInput(row, reader, opts.scannedAt || new Date().toISOString());
    if (!manifest) {
      details.missing.push({
        sessionPath: row.sessionPath,
        expectedDomain: input.domain,
        expectedKind: input.kind,
        ownerAgentId: input.ownerAgentId || null,
        sources: [...(row.sources || [])],
      });
      continue;
    }
    manifested += 1;
    if (manifest.domain !== input.domain || manifest.kind !== input.kind) {
      details.domainMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualDomain: manifest.domain,
        actualKind: manifest.kind,
        expectedDomain: input.domain,
        expectedKind: input.kind,
        sources: [...(row.sources || [])],
      });
    }
    if (input.ownerAgentId && manifest.ownerAgentId !== input.ownerAgentId) {
      details.ownerMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualOwnerAgentId: manifest.ownerAgentId || null,
        expectedOwnerAgentId: input.ownerAgentId,
        sources: [...(row.sources || [])],
      });
    }
    if (manifest.lifecycle !== input.lifecycle) {
      details.lifecycleMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualLifecycle: manifest.lifecycle,
        expectedLifecycle: input.lifecycle,
        sources: [...(row.sources || [])],
      });
    }
  }

  const missingLocatorKeys = new Set();
  for (const manifest of opts.store.list?.() || []) {
    const sessionPath = manifest?.currentLocator?.path || null;
    if (!LOCATOR_REQUIRED_LIFECYCLES.has(manifest?.lifecycle)) continue;
    if (!sessionPath || fs.existsSync(sessionPath)) continue;
    const key = sessionLocatorKey(sessionPath);
    if (missingLocatorKeys.has(key)) continue;
    missingLocatorKeys.add(key);
    details.missingLocators.push({
      sessionId: manifest.sessionId || null,
      sessionPath,
      domain: manifest.domain || null,
      kind: manifest.kind || null,
      source: "manifest_current_locator",
    });
  }
  for (const warning of discovery.diagnostics) {
    if (warning.type !== "missing_source_locator") continue;
    const key = sessionLocatorKey(warning.sessionPath);
    if (missingLocatorKeys.has(key)) continue;
    missingLocatorKeys.add(key);
    details.missingLocators.push({
      sessionId: null,
      sessionPath: warning.sessionPath,
      source: warning.source,
      sourcePath: warning.sourcePath || null,
    });
  }

  return {
    discovered: discovery.sessions.length,
    manifested,
    missing: details.missing.length,
    missingLocator: details.missingLocators.length,
    domainMismatch: details.domainMismatches.length,
    ownerMismatch: details.ownerMismatches.length,
    lifecycleMismatch: details.lifecycleMismatches.length,
    details,
  };
}

export function migrateLegacySessions(opts: any = {}) {
  if (!opts.hanaHome) throw new Error("migrateLegacySessions requires hanaHome");
  if (!opts.store) throw new Error("migrateLegacySessions requires store");

  const hanaHome = path.resolve(opts.hanaHome);
  const migratedAt = opts.migratedAt || new Date().toISOString();
  const result: any = { scanned: 0, created: 0, existing: 0, skipped: 0, skippedDetails: [] };
  const discovery = discoverLegacySessions({
    hanaHome,
    ...(opts.agentsDir ? { agentsDir: opts.agentsDir } : {}),
  });
  const reader = createLegacyRowReader();

  for (const row of discovery.sessions) {
    result.scanned += 1;
    try {
      const { candidates, input } = expectedManifestInput(row, reader, migratedAt);
      const titleState = reader.titleState(row);
      let existing = opts.store.resolveByLocatorPath(row.sessionPath);
      if (existing) {
        existing = repairExistingLocatorIfNeeded(opts.store, existing, row.sessionPath);
        if (!existing.ownerAgentId && typeof opts.store.backfillOwnerAgentId === "function") {
          existing = opts.store.backfillOwnerAgentId(existing.sessionId, input.ownerAgentId);
        }
        if (typeof opts.store.repairLegacyScanMetadata === "function") {
          existing = opts.store.repairLegacyScanMetadata(existing.sessionId, {
            ownerAgentId: input.ownerAgentId,
            ownerAgentIdSource: row.ownerAgentIdSource,
            domain: input.domain,
            kind: input.kind,
            provenance: input.provenance,
            migration: input.migration,
          });
        }
        if (
          existing?.migration?.source === "legacy_scan"
          && existing.lifecycle !== input.lifecycle
          && typeof opts.store.updateLocatorLifecycle === "function"
        ) {
          existing = opts.store.updateLocatorLifecycle(
            existing.sessionId,
            row.sessionPath,
            input.lifecycle,
            "legacy_scan_lifecycle_repair",
            { domain: existing.domain, kind: existing.kind },
          );
        }
        const permissionRepaired = repairPermissionSnapshotFromLegacyMeta(opts.store, existing, candidates);
        const settled = permissionRepaired || existing;
        importLegacyCapabilitySnapshot(opts.store, settled, candidates);
        importLegacyExecutorMetadata(opts.store, settled, candidates);
        if (titleState.titlesPath) {
          backfillLegacyTitleSessionIdKey(
            titleState.titlesPath,
            titleState.titles,
            row.titleSessionDir,
            row.sessionPath,
            settled,
          );
        }
        result.existing += 1;
        continue;
      }

      const manifest = opts.store.createForPath(input);
      importLegacyCapabilitySnapshot(opts.store, manifest, candidates);
      importLegacyExecutorMetadata(opts.store, manifest, candidates);
      if (titleState.titlesPath) {
        backfillLegacyTitleSessionIdKey(
          titleState.titlesPath,
          titleState.titles,
          row.titleSessionDir,
          row.sessionPath,
          manifest,
        );
      }
      result.created += 1;
    } catch (error) {
      if (opts.stopOnError === true) throw error;
      result.skipped += 1;
      if (result.skippedDetails.length < MAX_SKIPPED_DETAILS) {
        result.skippedDetails.push({
          sessionPath: row.sessionPath,
          error: error?.message || String(error),
        });
      }
    }
  }

  return result;
}
