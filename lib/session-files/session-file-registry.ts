import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { detectMime, extOfName, inferFileKind } from "../file-metadata.ts";

export const SESSION_FILE_SIDECAR_VERSION = 1;
export const SESSION_FILE_CACHE_INACTIVE_TTL_MS = 72 * 60 * 60 * 1000;
const AUDIO_WAVEFORM_VERSION = 1;
const MAX_AUDIO_WAVEFORM_PEAKS = 160;

export function sessionFileSidecarPath(sessionPath) {
  return `${sessionPath}.files.json`;
}

export function sessionFilesCacheDir(hanakoHome, sessionPath) {
  if (!hanakoHome) throw new Error("hanakoHome is required for session file cache");
  if (!sessionPath) throw new Error("sessionPath is required for session file cache");
  const hash = createHash("sha256").update(String(sessionPath)).digest("hex").slice(0, 24);
  return path.join(hanakoHome, "session-files", hash);
}

export function moveSessionFileSidecarSync(fromSessionPath, toSessionPath) {
  const src = sessionFileSidecarPath(fromSessionPath);
  if (!fs.existsSync(src)) return false;
  const dest = sessionFileSidecarPath(toSessionPath);
  if (fs.existsSync(dest)) throw new Error("stage file sidecar destination already exists");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

export function deleteSessionFileSidecarSync(sessionPath) {
  fs.rmSync(sessionFileSidecarPath(sessionPath), { force: true });
}

export class SessionFileRegistry {
  declare _byId: any;
  declare _idsBySession: any;
  declare _loadedSessions: any;
  declare _managedCacheRoot: any;
  declare _now: any;
  declare _sidecarsBySession: any;
  constructor({ now = () => Date.now(), managedCacheRoot = null }: any = {}) {
    this._now = now;
    this._managedCacheRoot = managedCacheRoot ? normalizeExistingOrResolvedPath(managedCacheRoot) : null;
    this._byId = new Map();
    this._idsBySession = new Map();
    this._sidecarsBySession = new Map();
    this._loadedSessions = new Set();
  }

  registerFile({
    sessionPath,
    filePath,
    label,
    origin = "unknown",
    storageKind = "external",
    operation = null,
    presentation = "attachment",
    listed = true,
    waveform = null,
  }: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to register a session file");
    if (!filePath || !path.isAbsolute(filePath)) throw new Error("filePath must be an absolute path");
    this._hydrateSession(sessionPath);

    let realPath;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      throw new Error(`file not found: ${filePath}`);
    }

    const stat = fs.statSync(realPath);
    const filename = path.basename(filePath);
    const ext = extOfName(filename);
    const sample = stat.isFile() ? readSample(realPath) : Buffer.alloc(0);
    const mime = stat.isDirectory()
      ? "inode/directory"
      : detectMime(sample, "application/octet-stream", filename);
    const existing = this._findSessionFileByRealPath(sessionPath, realPath);
    const id = existing?.id || buildSessionFileId({ sessionPath, realPath });
    const resolvedOperation = operation || inferOperation(origin);
    const operations = addUnique(existing?.operations, resolvedOperation);
    const normalizedWaveform = normalizeAudioWaveform(waveform);

    const entry = Object.freeze({
      ...(existing || {}),
      id,
      sessionPath,
      origin,
      filePath,
      realPath,
      displayName: label || filename,
      filename,
      label: label || filename,
      ext,
      mime,
      size: stat.isDirectory() ? null : stat.size,
      kind: inferFileKind({ mime, ext, isDirectory: stat.isDirectory() }),
      isDirectory: stat.isDirectory(),
      createdAt: existing?.createdAt || this._now(),
      mtimeMs: stat.mtimeMs,
      storageKind,
      presentation: normalizePresentation(presentation),
      listed: listed !== false,
      status: "available",
      missingAt: null,
      operations,
      ...(normalizedWaveform ? { waveform: normalizedWaveform } : {}),
    });

    this._remember(entry, sessionPath);
    const sidecar = this._sidecarsBySession.get(sessionPath) || emptySidecar(sessionPath, this._now());
    sidecar.files[id] = entry;
    if (shouldAppendRef(sidecar.refs, { fileId: id, origin, operation: resolvedOperation })) {
      sidecar.refs.push({
        fileId: id,
        origin,
        operation: resolvedOperation,
        storageKind,
        createdAt: this._now(),
      });
    }
    sidecar.updatedAt = this._now();
    this._sidecarsBySession.set(sessionPath, sidecar);
    this._saveSidecar(sessionPath);
    return entry;
  }

  get(fileId, { sessionPath }: any = {}) {
    if (fileId && sessionPath && !this._byId.has(fileId)) this._hydrateSession(sessionPath);
    return this._byId.get(fileId) || null;
  }

  getByFilePath(filePath, { sessionPath }: any = {}) {
    if (!filePath) return null;
    if (sessionPath) this._hydrateSession(sessionPath);
    const target = normalizeExistingOrResolvedPath(filePath);
    const ids = sessionPath
      ? (this._idsBySession.get(sessionPath) || [])
      : Array.from(this._byId.keys());
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry) continue;
      const candidates = [entry.filePath, entry.realPath].filter(Boolean);
      if (candidates.some((candidate) => normalizeExistingOrResolvedPath(candidate) === target)) {
        return entry;
      }
    }
    return null;
  }

  updateTranscription(fileId, transcription, { sessionPath }: any = {}) {
    if (!fileId) throw new Error("fileId is required to update transcription");
    if (sessionPath) this._hydrateSession(sessionPath);
    const existing = this._byId.get(fileId);
    if (!existing) throw new Error(`session file not found: ${fileId}`);
    const ownerSessionPath = sessionPath || existing.sessionPath;
    if (!ownerSessionPath) throw new Error("sessionPath is required to update transcription");
    this._hydrateSession(ownerSessionPath);
    const current = this._byId.get(fileId);
    if (!current) throw new Error(`session file not found: ${fileId}`);
    const now = this._now();
    const nextTranscription = normalizeTranscription(transcription, current.transcription, now);
    const next = freezeEntry({
      ...current,
      transcription: nextTranscription,
    });
    this._remember(next, ownerSessionPath);
    const sidecar = this._sidecarsBySession.get(ownerSessionPath) || emptySidecar(ownerSessionPath, now);
    sidecar.files[fileId] = next;
    sidecar.updatedAt = now;
    this._sidecarsBySession.set(ownerSessionPath, sidecar);
    this._saveSidecar(ownerSessionPath);
    return next;
  }

  list(sessionPath) {
    this._hydrateSession(sessionPath);
    const ids = this._idsBySession.get(sessionPath) || [];
    return ids.map(id => this._byId.get(id)).filter(Boolean);
  }

  unloadSession(sessionPath) {
    if (!sessionPath) throw new Error("sessionPath is required to unload session files");
    const ids = new Set(this._idsBySession.get(sessionPath) || []);
    const sidecar = this._sidecarsBySession.get(sessionPath);
    for (const file of Object.values(sidecar?.files || {}) as any) {
      if ((file as any)?.id) ids.add((file as any).id);
    }
    const hadSession = this._loadedSessions.has(sessionPath)
      || this._sidecarsBySession.has(sessionPath)
      || this._idsBySession.has(sessionPath);

    for (const [indexedSessionPath, indexedIds] of this._idsBySession) {
      const retainedIds = indexedIds.filter(id => !ids.has(id));
      if (retainedIds.length === indexedIds.length) continue;
      if (retainedIds.length) {
        this._idsBySession.set(indexedSessionPath, retainedIds);
      } else {
        this._idsBySession.delete(indexedSessionPath);
      }
    }
    this._sidecarsBySession.delete(sessionPath);
    this._loadedSessions.delete(sessionPath);

    for (const id of ids) {
      if (!this._isFileIdReferencedByLoadedSession(id)) this._byId.delete(id);
    }
    return hadSession;
  }

  cleanupColdSessionFiles({ sessionPath, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS }: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to clean session files");
    this._hydrateSession(sessionPath);

    let sessionStat;
    try {
      sessionStat = fs.statSync(sessionPath);
    } catch {
      return { sessionPath, cold: false, skipped: "missing_session", expired: 0, deleted: 0 };
    }

    const ageMs = this._now() - sessionStat.mtimeMs;
    if (ageMs < maxInactiveMs) {
      return { sessionPath, cold: false, ageMs, expired: 0, deleted: 0 };
    }

    const sidecar = this._sidecarsBySession.get(sessionPath) || emptySidecar(sessionPath, this._now());
    let expired = 0;
    let deleted = 0;
    let changed = false;

    for (const [id, file] of Object.entries(sidecar.files || {}) as any) {
      if (!isManagedCache(file) || file.status === "expired") continue;
      const target = file.realPath || file.filePath;
      if (target) {
        this._assertManagedCacheTarget(target);
        const existed = fs.existsSync(target);
        fs.rmSync(target, { recursive: true, force: true });
        if (existed) deleted += 1;
      }
      const next = freezeEntry({
        ...(file as any),
        status: "expired",
        missingAt: this._now(),
      });
      sidecar.files[id] = next;
      this._remember(next, sessionPath);
      expired += 1;
      changed = true;
    }

    if (changed) {
      sidecar.updatedAt = this._now();
      this._sidecarsBySession.set(sessionPath, sidecar);
      this._saveSidecar(sessionPath);
    }

    return { sessionPath, cold: true, ageMs, expired, deleted };
  }

  cleanupColdSessions({ agentsDir, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS }: any = {}) {
    if (!agentsDir) throw new Error("agentsDir is required to clean session files");
    const sessions = collectSessionPaths(agentsDir);
    const results = [];
    for (const sessionPath of sessions) {
      if (!fs.existsSync(sessionFileSidecarPath(sessionPath))) continue;
      results.push(this.cleanupColdSessionFiles({ sessionPath, maxInactiveMs }));
    }
    return results;
  }

  _hydrateSession(sessionPath) {
    if (!sessionPath) throw new Error("sessionPath is required");
    if (this._loadedSessions.has(sessionPath)) return;
    const sidecar = this._readSidecar(sessionPath);
    this._sidecarsBySession.set(sessionPath, sidecar);
    this._loadedSessions.add(sessionPath);
    for (const raw of Object.values(sidecar.files || {}) as any) {
      const entry = freezeEntry({
        ...(raw as any),
        operations: (raw as any).operations || operationsFromRefs(sidecar.refs, raw),
      });
      this._remember(entry, sessionPath);
    }
  }

  _findSessionFileByRealPath(sessionPath, realPath) {
    const ids = this._idsBySession.get(sessionPath) || [];
    const target = normalizeExistingOrResolvedPath(realPath);
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry) continue;
      const entryRealPath = normalizeExistingOrResolvedPath(entry.realPath || entry.filePath);
      if (entryRealPath === target) return entry;
    }
    return null;
  }

  _remember(entry, requestedSessionPath = null) {
    this._byId.set(entry.id, entry);
    const sessions = new Set([entry.sessionPath, requestedSessionPath].filter(Boolean));
    for (const sessionPath of sessions) {
      if (!this._idsBySession.has(sessionPath)) this._idsBySession.set(sessionPath, []);
      const ids = this._idsBySession.get(sessionPath);
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
  }

  _isFileIdReferencedByLoadedSession(fileId) {
    for (const ids of this._idsBySession.values()) {
      if (ids.includes(fileId)) return true;
    }
    return false;
  }

  _readSidecar(sessionPath) {
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    if (!fs.existsSync(sidecarPath)) return emptySidecar(sessionPath, this._now());
    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      if (raw?.version !== SESSION_FILE_SIDECAR_VERSION || !raw.files || typeof raw.files !== "object") {
        throw new Error("invalid sidecar schema");
      }
      return {
        version: SESSION_FILE_SIDECAR_VERSION,
        sessionPath: raw.sessionPath || sessionPath,
        files: raw.files,
        refs: Array.isArray(raw.refs) ? raw.refs : [],
        createdAt: raw.createdAt || this._now(),
        updatedAt: raw.updatedAt || this._now(),
      };
    } catch (err) {
      throw new Error(`failed to read session file sidecar: ${sidecarPath}: ${(err as any).message}`);
    }
  }

  _saveSidecar(sessionPath) {
    const sidecar = this._sidecarsBySession.get(sessionPath);
    if (!sidecar) return;
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    const tmpPath = `${sidecarPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, sidecarPath);
  }

  _assertManagedCacheTarget(filePath) {
    if (!this._managedCacheRoot) return;
    const realPath = normalizeExistingOrResolvedPath(filePath);
    if (!isInsideRoot(realPath, this._managedCacheRoot)) {
      throw new Error(`managed cache file is outside session-files root: ${filePath}`);
    }
  }
}

function emptySidecar(sessionPath, now) {
  return {
    version: SESSION_FILE_SIDECAR_VERSION,
    sessionPath,
    files: {},
    refs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function freezeEntry(raw) {
  const transcription = normalizeTranscription(raw.transcription, null, raw.updatedAt || raw.createdAt || Date.now());
  const waveform = normalizeAudioWaveform(raw.waveform);
  const { transcription: _transcription, waveform: _waveform, ...rest } = raw;
  return Object.freeze({
    ...rest,
    storageKind: raw.storageKind || "external",
    presentation: normalizePresentation(raw.presentation),
    listed: raw.listed !== false,
    status: raw.status || "available",
    missingAt: raw.missingAt ?? null,
    operations: Array.isArray(raw.operations) ? raw.operations : [],
    ...(transcription ? { transcription } : {}),
    ...(waveform ? { waveform } : {}),
  });
}

function normalizeTranscription(value, existing = null, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = ["pending", "ready", "failed"].includes(value.status) ? value.status : null;
  if (!status) return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const error = typeof value.error === "string" ? value.error.trim() : "";
  const createdAt = Number.isFinite(Number(value.createdAt))
    ? Number(value.createdAt)
    : Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : now;
  return {
    status,
    ...(text ? { text } : {}),
    ...(typeof value.providerId === "string" && value.providerId.trim() ? { providerId: value.providerId.trim() } : {}),
    ...(typeof value.modelId === "string" && value.modelId.trim() ? { modelId: value.modelId.trim() } : {}),
    ...(typeof value.protocolId === "string" && value.protocolId.trim() ? { protocolId: value.protocolId.trim() } : {}),
    ...(typeof value.language === "string" && value.language.trim() ? { language: value.language.trim() } : {}),
    ...(Number.isFinite(Number(value.durationMs)) ? { durationMs: Number(value.durationMs) } : {}),
    ...(error ? { error } : {}),
    createdAt,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : now,
  };
}

function isManagedCache(file) {
  return file?.storageKind === "managed_cache";
}

function normalizeAudioWaveform(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.peaks)) return null;
  const peaks = value.peaks
    .slice(0, MAX_AUDIO_WAVEFORM_PEAKS)
    .map((peak) => clampPeak(Number(peak)))
    .filter((peak) => Number.isFinite(peak));
  if (!peaks.length) return null;
  const durationMs = Number(value.durationMs);
  const source = value.source === "fallback" ? "fallback" : "computed";
  return {
    version: AUDIO_WAVEFORM_VERSION,
    peaks,
    ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}),
    source,
  };
}

function clampPeak(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function collectSessionPaths(agentsDir) {
  let agents = [];
  try { agents = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agent.name, "sessions");
    collectJsonlFiles(sessionsDir, sessions);
    collectJsonlFiles(path.join(sessionsDir, "archived"), sessions);
  }
  return sessions;
}

function collectJsonlFiles(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function normalizeExistingOrResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function buildSessionFileId({ sessionPath, realPath }) {
  const hash = createHash("sha256")
    .update(JSON.stringify([sessionPath, realPath]))
    .digest("hex")
    .slice(0, 16);
  return `sf_${hash}`;
}

function inferOperation(origin) {
  switch (origin) {
    case "stage_files":
      return "staged";
    case "user_upload":
      return "uploaded";
    case "user_attachment":
    case "bridge_inbound":
      return "attached";
    case "agent_write":
    case "agent_artifact":
    case "plugin_output":
    case "install_skill_output":
      return "created";
    case "agent_edit":
      return "modified";
    case "browser_screenshot":
      return "captured";
    case "skill_install_source":
    case "plugin_install_source":
      return "referenced";
    case "bridge_manual_send":
      return "sent";
    case "voice_input":
      return "recorded";
    default:
      return "registered";
  }
}

function normalizePresentation(value) {
  return value === "voice-input" ? "voice-input" : "attachment";
}

function addUnique(existing, value) {
  const out = Array.isArray(existing) ? [...existing] : [];
  if (value && !out.includes(value)) out.push(value);
  return out;
}

function shouldAppendRef(refs, next) {
  if (next.operation !== "staged") return true;
  return !(refs || []).some(ref =>
    ref?.fileId === next.fileId
    && ref?.origin === next.origin
    && (ref?.operation || inferOperation(ref?.origin)) === next.operation
  );
}

function operationsFromRefs(refs, file) {
  const operations = [];
  for (const ref of refs || []) {
    if (ref?.fileId !== file?.id) continue;
    const operation = ref.operation || inferOperation(ref.origin);
    if (operation && !operations.includes(operation)) operations.push(operation);
  }
  return operations;
}
