import fs from "fs";
import path from "path";
import { normalizeResourceRef, resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceEdit,
  ResourceListResult,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceSearchResult,
  ResourceStat,
  ResourceVersion,
} from "../types.ts";

type Guard = {
  check: (absolutePath: string, operation: "read" | "write" | "delete") => { allowed: boolean; reason?: string };
};

type LocalFsProviderOptions = {
  cwd: string;
  guard?: Guard;
};

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export class LocalFsProvider {
  declare cwd: string;
  declare guard: Guard | null;

  constructor({ cwd, guard = null }: LocalFsProviderOptions) {
    this.cwd = cwd || process.cwd();
    this.guard = guard;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      write: true,
      edit: true,
      list: true,
      search: true,
      watch: true,
      materialize: true,
      copy: true,
      delete: true,
      mkdir: true,
    };
  }

  async stat(ref: ResourceRef | unknown): Promise<ResourceStat> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    if (!fs.existsSync(filePath)) {
      return {
        resourceKey: localResourceKey(filePath),
        resource: this.resourceForPath(filePath),
        exists: false,
        isDirectory: false,
        filePath,
      };
    }
    const stat = fs.statSync(filePath);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      exists: true,
      isDirectory: stat.isDirectory(),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async read(ref: ResourceRef | unknown): Promise<ResourceReadResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`resource is not a file: ${filePath}`);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      content: fs.readFileSync(filePath),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async write(ref: ResourceRef | unknown, content: string | Buffer): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "write");
    const existed = fs.existsSync(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return this.mutationResult(filePath, existed ? "modified" : "created");
  }

  async edit(ref: ResourceRef | unknown, edits: ResourceEdit[]): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    this.assertAllowed(filePath, "write");
    let text = fs.readFileSync(filePath, "utf-8");
    for (const edit of edits || []) {
      if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
        throw new Error("resource edit requires oldText and newText");
      }
      if (!text.includes(edit.oldText)) {
        throw new Error("resource edit oldText not found");
      }
      text = text.replace(edit.oldText, edit.newText);
    }
    fs.writeFileSync(filePath, text, "utf-8");
    return this.mutationResult(filePath, "modified");
  }

  async mkdir(ref: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "write");
    const existed = fs.existsSync(filePath);
    fs.mkdirSync(filePath, { recursive: true });
    return this.mutationResult(filePath, existed ? "modified" : "created");
  }

  async delete(ref: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "delete");
    const result = this.mutationResult(filePath, "modified");
    fs.rmSync(filePath, { recursive: true, force: false });
    return result;
  }

  async copy(from: ResourceRef | unknown, to: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const sourcePath = this.resolvePath(from);
    const targetPath = this.resolvePath(to);
    this.assertAllowed(sourcePath, "read");
    this.assertAllowed(targetPath, "write");
    const existed = fs.existsSync(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    return this.mutationResult(targetPath, existed ? "modified" : "created");
  }

  async materialize(ref: ResourceRef | unknown): Promise<MaterializeResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    const stat = fs.statSync(filePath);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      filePath,
      version: versionFromStat(stat),
    };
  }

  async list(ref: ResourceRef | unknown): Promise<ResourceListResult> {
    const dirPath = this.resolvePath(ref);
    this.assertAllowed(dirPath, "read");
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      resourceKey: localResourceKey(dirPath),
      resource: this.resourceForPath(dirPath),
      items,
    };
  }

  async search(ref: ResourceRef | unknown, { query }: { query?: string } = {}): Promise<ResourceSearchResult> {
    const rootPath = this.resolvePath(ref);
    this.assertAllowed(rootPath, "read");
    const needle = String(query || "");
    const matches = needle ? searchText(rootPath, needle, this.guard) : [];
    return {
      resourceKey: localResourceKey(rootPath),
      resource: this.resourceForPath(rootPath),
      matches,
    };
  }

  resolvePath(ref: ResourceRef | unknown): string {
    const normalized = normalizeResourceRef(ref);
    if (normalized.kind !== "local-file") {
      throw new Error(`local_fs provider cannot resolve ${normalized.kind}`);
    }
    return path.isAbsolute(normalized.path)
      ? path.normalize(normalized.path)
      : path.resolve(this.cwd, normalized.path);
  }

  resourceForPath(filePath: string): ResourceDescriptor {
    return {
      kind: "local-file",
      path: filePath,
      filePath,
      provider: "local_fs",
    };
  }

  mutationResult(filePath: string, changeType: "created" | "modified"): ResourceMutationResult {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    return {
      changeType,
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      ...(stat ? { version: versionFromStat(stat) } : {}),
      filePath,
    };
  }

  assertAllowed(filePath: string, operation: "read" | "write" | "delete"): void {
    if (!this.guard) return;
    const result = this.guard.check(filePath, operation);
    if (!result?.allowed) throw new Error(result?.reason || `resource ${operation} denied: ${filePath}`);
  }
}

function localResourceKey(filePath: string): string {
  return resourceKeyForRef({ kind: "local-file", path: filePath });
}

function versionFromStat(stat: fs.Stats): ResourceVersion {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.isDirectory() ? null : stat.size,
  };
}

function searchText(rootPath: string, query: string, guard: Guard | null) {
  const matches: { filePath: string; line: number; text: string }[] = [];
  const visit = (current: string) => {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(path.basename(current))) return;
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) return;
    if (guard) {
      const allowed = guard.check(current, "read");
      if (!allowed.allowed) return;
    }
    const text = fs.readFileSync(current, "utf-8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(query)) matches.push({ filePath: current, line: index + 1, text: line });
    });
  };
  visit(rootPath);
  return matches.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}
