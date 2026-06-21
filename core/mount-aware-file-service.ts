import crypto from "crypto";
import fs from "fs";
import path from "path";
import { loadStudioMountRegistry } from "./studio-mounts.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { resourceKeyForRef } from "../lib/resource-io/resource-refs.ts";

const log = createModuleLogger("mount-files");

const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);
const SEARCH_LIMIT = 80;
export const WORKBENCH_RESOURCE_EVENTS = Symbol.for("hana.workbenchResourceEvents");

export class MountAwareFileError extends Error {
  declare code: string;
  declare status: number;

  constructor(message, { code = "file_action_failed", status = 400 } = {}) {
    super(message);
    this.name = "MountAwareFileError";
    this.code = code;
    this.status = status;
  }
}

export class MountAwareFileService {
  declare _hanakoHome: string;
  declare _defaultRoot: string;
  declare _studioId: string;
  declare _createCheckpoint: any;
  declare _discloseNativeRoot: boolean;

  constructor({
    hanakoHome,
    defaultRoot,
    studioId,
    createCheckpoint,
    discloseNativeRoot = false,
  }: Record<string, any> = {}) {
    if (!hanakoHome) throw new Error("hanakoHome required");
    this._hanakoHome = hanakoHome;
    this._defaultRoot = defaultRoot || null;
    this._studioId = studioId || null;
    this._createCheckpoint = typeof createCheckpoint === "function" ? createCheckpoint : null;
    // 本地 owner（桌面端 loopback principal）可以拿到 local_fs 根的 native 绝对路径，
    // 用于"打开文件夹/拖拽真实路径"等本地集成；远端 principal 一律不披露。
    this._discloseNativeRoot = discloseNativeRoot === true;
  }

  resolveRoot(rootId = "default") {
    return publicRoot(this._resolveRootInternal(rootId), this._discloseNativeRoot);
  }

  resolveDirectory(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    const normalized = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return dir;
  }

  async listFiles(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const normalized = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      subdir: normalized,
      files: await listFiles(dir),
    };
  }

  async searchFiles(rootId = "default", query = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const q = String(query || "").trim();
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      query: q,
      results: q ? await searchFiles(root.path, q) : [],
    };
  }

  contentTarget(rootId = "default", subdir = "", name) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "read");
    const normalized = normalizeSubdirOrThrow(subdir);
    const filename = normalizePlainNameOrThrow(name);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    const filePath = resolveFileTarget(root.path, dir, filename);
    if (!filePath) throw fileError("invalid path", "invalid_path", 400);
    return { root, filePath, filename };
  }

  async mkdir(rootId, subdir, body: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(target, { recursive: false });
    return withWorkbenchResourceEvents(
      workbenchWriteResult(root, "mkdir", { files: await listFiles(dir) }, this._discloseNativeRoot),
      [changedWorkbenchResourceEvent(target, "created")],
    );
  }

  async writeText(rootId, subdir, body: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    const existed = fs.existsSync(target);
    const expectedVersion = normalizeExpectedVersionOrNull(body.expectedVersion);
    if (expectedVersion) {
      const currentVersion = statFileVersionOrNull(target);
      if (!currentVersion || !fileVersionsMatch(currentVersion, expectedVersion)) {
        return {
          ok: false,
          action: body.action,
          rootId: root.id,
          mountId: root.mountId || root.id,
          mount: publicRoot(root, this._discloseNativeRoot),
          conflict: true,
          version: currentVersion,
          files: await listFiles(dir),
        };
      }
    }
    if (fs.existsSync(target) && this._createCheckpoint) {
      await this._createCheckpoint({ filePath: target, reason: "mobile-workbench-edit" }).catch(() => null);
    }
    fs.writeFileSync(target, String(body.content ?? ""), "utf-8");
    return withWorkbenchResourceEvents({
      ok: true,
      action: body.action,
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      version: statFileVersionOrNull(target),
      files: await listFiles(dir),
    }, [changedWorkbenchResourceEvent(target, existed ? "modified" : "created")]);
  }

  async rename(rootId, subdir, body: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const oldName = normalizePlainNameOrThrow(body.oldName);
    const newName = normalizePlainNameOrThrow(body.newName);
    const source = resolveFileTarget(root.path, dir, oldName);
    const target = resolveFileTarget(root.path, dir, newName);
    if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
    fs.renameSync(source, target);
    return withWorkbenchResourceEvents(
      workbenchWriteResult(root, "rename", { files: await listFiles(dir) }, this._discloseNativeRoot),
      [renamedWorkbenchResourceEvent(source, target)],
    );
  }

  async move(rootId, subdir, body: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    const source = resolveFileTarget(root.path, dir, name);
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!source || !destDir) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(destDir, { recursive: true });
    const target = path.join(destDir, name);
    fs.renameSync(source, target);
    return withWorkbenchResourceEvents(
      workbenchWriteResult(root, "move", { files: await listFiles(dir) }, this._discloseNativeRoot),
      [renamedWorkbenchResourceEvent(source, target)],
    );
  }

  async movePaths(rootId, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const items = Array.isArray(body.items) ? body.items : [];
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    const currentSubdir = normalizeSubdirOrThrow(body.currentSubdir || "");
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!destDir) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(destDir, { recursive: true });

    const touchedSubdirs = new Set([currentSubdir, destSubdir]);
    const events = [];
    for (const item of items) {
      const sourceSubdir = normalizeSubdirOrThrow(item?.sourceSubdir || "");
      const name = normalizePlainNameOrThrow(item?.name);
      const sourceDir = resolveInsideRoot(root.path, sourceSubdir);
      if (!sourceDir) throw fileError("invalid path", "invalid_path", 400);
      const source = resolveFileTarget(root.path, sourceDir, name);
      const target = resolveFileTarget(root.path, destDir, name);
      if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
      fs.renameSync(source, target);
      events.push(renamedWorkbenchResourceEvent(source, target));
      touchedSubdirs.add(sourceSubdir);
    }

    const filesByPath = {};
    for (const subdir of touchedSubdirs) {
      const dir = resolveInsideRoot(root.path, subdir);
      if (dir) filesByPath[subdir] = await listFiles(dir);
    }
    const currentDir = resolveInsideRoot(root.path, currentSubdir);
    return withWorkbenchResourceEvents(
      workbenchWriteResult(root, "movePaths", {
        filesByPath,
        files: currentDir ? await listFiles(currentDir) : [],
      }, this._discloseNativeRoot),
      events,
    );
  }

  async safeDelete(rootId, subdir, body: Record<string, any> = {}) {
    const { root, dir, normalizedSubdir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const source = resolveFileTarget(root.path, dir, name);
    if (!source || !fs.existsSync(source)) throw fileError("file not found", "file_not_found", 404);
    const trashId = `trash_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const trashDir = path.join(this._hanakoHome, "trash", "mobile-workbench", trashId);
    fs.mkdirSync(trashDir, { recursive: true });
    const payloadPath = path.join(trashDir, "payload");
    fs.renameSync(source, payloadPath);
    fs.writeFileSync(path.join(trashDir, "metadata.json"), JSON.stringify({
      schemaVersion: 1,
      trashId,
      rootId: root.id,
      mountId: root.mountId || root.id,
      originalName: name,
      originalSubdir: normalizedSubdir,
      deletedAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
    return withWorkbenchResourceEvents(
      workbenchWriteResult(root, "safeDelete", { trashId, files: await listFiles(dir) }, this._discloseNativeRoot),
      [deletedWorkbenchResourceEvent(source)],
    );
  }

  writeFileTarget(rootId, subdir, name) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const filename = normalizePlainNameOrThrow(name);
    const target = resolveFileTarget(root.path, dir, filename);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    return { root, dir, filename, target };
  }

  async filesForDirectory(rootId, subdir) {
    return (await this.listFiles(rootId, subdir)).files;
  }

  _writeDir(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalizedSubdir);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(dir, { recursive: true });
    return { root, dir, normalizedSubdir };
  }

  _resolveRootInternal(rootId = "default") {
    const id = typeof rootId === "string" && rootId.trim() ? rootId.trim() : "default";
    if (id === "default") {
      if (!this._defaultRoot) throw fileError("no workspace", "no_workspace", 400);
      fs.mkdirSync(this._defaultRoot, { recursive: true });
      return {
        id: "default",
        mountId: "default",
        workspaceId: "default",
        label: "Default",
        presentation: "folder",
        path: this._defaultRoot,
        capabilities: ["list", "read", "write"],
        sourceKind: "storage",
        provider: "local_fs",
      };
    }
    const mount = findLocalFsMount(this._hanakoHome, this._studioId, id);
    if (!mount) throw fileError("unknown root", "unknown_root", 404);
    const rootPath = mount.rootLocator?.path;
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw fileError("invalid mount root", "invalid_mount_root", 400);
    }
    fs.mkdirSync(rootPath, { recursive: true });
    return {
      id: mount.mountId,
      mountId: mount.mountId,
      workspaceId: mount.mountId,
      label: mount.label,
      presentation: mount.presentation,
      path: rootPath,
      capabilities: mount.capabilities,
      sourceKind: mount.sourceKind,
      provider: mount.provider,
    };
  }
}

function workbenchWriteResult(root, action, extra = {}, discloseNativeRoot = false) {
  return {
    ok: true,
    action,
    rootId: root.id,
    mountId: root.mountId || root.id,
    mount: publicRoot(root, discloseNativeRoot),
    ...extra,
  };
}

export function workbenchResourceEventsFromResult(result) {
  return Array.isArray(result?.[WORKBENCH_RESOURCE_EVENTS])
    ? result[WORKBENCH_RESOURCE_EVENTS]
    : [];
}

function withWorkbenchResourceEvents(result, events) {
  Object.defineProperty(result, WORKBENCH_RESOURCE_EVENTS, {
    value: events.filter(Boolean),
    enumerable: false,
    configurable: false,
  });
  return result;
}

function changedWorkbenchResourceEvent(filePath, changeType) {
  const version = resourceVersionForPath(filePath);
  return {
    type: "changed",
    input: {
      changeType,
      resourceKey: resourceKeyForRef({ kind: "local-file", path: filePath }),
      resource: localFileResource(filePath),
      ...(version ? { version } : {}),
      source: "api",
    },
  };
}

function deletedWorkbenchResourceEvent(filePath) {
  return {
    type: "deleted",
    input: {
      resourceKey: resourceKeyForRef({ kind: "local-file", path: filePath }),
      resource: localFileResource(filePath),
      source: "api",
    },
  };
}

function renamedWorkbenchResourceEvent(oldPath, newPath) {
  return {
    type: "renamed",
    input: {
      oldResourceKey: resourceKeyForRef({ kind: "local-file", path: oldPath }),
      newResourceKey: resourceKeyForRef({ kind: "local-file", path: newPath }),
      oldResource: localFileResource(oldPath),
      newResource: localFileResource(newPath),
      source: "api",
    },
  };
}

function localFileResource(filePath) {
  return {
    kind: "local-file",
    provider: "local_fs",
    path: filePath,
    filePath,
  };
}

function resourceVersionForPath(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.isDirectory() ? null : stat.size,
    };
  } catch {
    return null;
  }
}

function findLocalFsMount(hanakoHome, studioId, rootId) {
  if (!studioId) return null;
  let registry;
  try {
    registry = loadStudioMountRegistry(hanakoHome);
  } catch {
    return null;
  }
  return registry.mounts.find((mount) => mount.mountId === rootId
    && mount.hostStudioId === studioId
    && mount.status === "active"
    && mount.sourceKind === "storage"
    && mount.provider === "local_fs") || null;
}

function publicRoot(root, discloseNativeRoot = false) {
  const { path: rootPath, ...safe } = root;
  if (discloseNativeRoot && root.sourceKind === "storage" && root.provider === "local_fs"
    && typeof rootPath === "string" && rootPath) {
    return { ...safe, nativeRootPath: rootPath };
  }
  return safe;
}

function requireCapability(root, capability) {
  if (!root.capabilities?.includes(capability)) {
    throw fileError("mount capability denied", "mount_capability_denied", 403);
  }
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      items.push({
        name: entry.name,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      if (err.code !== "ENOENT") log.warn(`stat failed: ${err.message}`);
    }
  }
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

function statFileVersionOrNull(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      mtimeMs: stat.mtime.getTime(),
      size: stat.size,
    };
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`stat version failed: ${err.message}`);
    return null;
  }
}

function normalizeExpectedVersionOrNull(value) {
  if (value == null) return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
    throw fileError("invalid expected version", "invalid_expected_version", 400);
  }
  return {
    mtimeMs,
    size,
    sha256: typeof value.sha256 === "string" ? value.sha256 : undefined,
  };
}

function fileVersionsMatch(current, expected) {
  if (current.mtimeMs !== expected.mtimeMs) return false;
  if (current.size !== expected.size) return false;
  if (expected.sha256 && current.sha256 !== expected.sha256) return false;
  return true;
}

async function searchFiles(rootPath, query) {
  const needle = query.toLowerCase();
  const results = [];
  async function walk(dir) {
    if (results.length >= SEARCH_LIMIT) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (results.length >= SEARCH_LIMIT) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = toPortableRelative(rootPath, fullPath);
      const parentSubdir = toPortableRelative(rootPath, path.dirname(fullPath));
      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({
            name: entry.name,
            relativePath,
            parentSubdir,
            isDir: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch {}
      }
      if (entry.isDirectory()) await walk(fullPath);
    }
  }
  await walk(rootPath);
  return results.slice(0, SEARCH_LIMIT);
}

function resolveInsideRoot(rootPath, subdir) {
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const target = subdir ? path.join(rootPath, subdir) : rootPath;
  const targetReal = realPath(target);
  if (targetReal) {
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep) ? targetReal : null;
  }
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function resolveFileTarget(rootPath, dir, name) {
  const target = path.join(dir, name);
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const resolved = realPath(target);
  if (resolved) return resolved === rootReal || resolved.startsWith(rootReal + path.sep) ? resolved : null;
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function normalizeSubdirOrThrow(value) {
  const raw = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (raw.includes("\\") || raw.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) {
    throw fileError("invalid_subdir", "invalid_subdir", 400);
  }
  return raw;
}

function normalizePlainNameOrThrow(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith(".")) {
    throw fileError("invalid name", "invalid_name", 400);
  }
  return name;
}

function toPortableRelative(root, target) {
  return path.relative(root, target).split(path.sep).filter(Boolean).join("/");
}

function fileError(message, code, status) {
  return new MountAwareFileError(message, { code, status });
}

function realPath(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}
