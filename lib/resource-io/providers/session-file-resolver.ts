import fs from "fs";
import path from "path";
import { capabilityDenied, ResourceIOError } from "../errors.ts";
import { resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceStat,
  ResourceVersion,
} from "../types.ts";

type Options = {
  sessionFiles: {
    get: (fileId: string, options?: { sessionId?: string | null; sessionPath?: string | null }) => any;
  };
};

export class SessionFileResolverProvider {
  declare sessionFiles: Options["sessionFiles"];

  constructor({ sessionFiles }: Options) {
    if (!sessionFiles) throw new Error("sessionFiles is required");
    this.sessionFiles = sessionFiles;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      materialize: true,
      write: false,
      edit: false,
      list: false,
      search: false,
      watch: false,
      copy: false,
      delete: false,
      mkdir: false,
    };
  }

  async stat(ref: ResourceRef): Promise<ResourceStat> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = statIfPresent(filePath);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      exists: Boolean(stat),
      isDirectory: Boolean(stat?.isDirectory()),
      ...(stat ? { version: versionFromStat(stat) } : {}),
      filePath,
    };
  }

  async read(ref: ResourceRef): Promise<ResourceReadResult> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new ResourceIOError(`session file is not a regular file: ${normalized.fileId}`, {
        code: "resource_not_file",
        status: 409,
      });
    }
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      content: fs.readFileSync(filePath),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async materialize(ref: ResourceRef): Promise<MaterializeResult> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = fs.statSync(filePath);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      filePath,
      version: versionFromStat(stat),
    };
  }

  async write(_ref?: ResourceRef, _content?: string | Buffer): Promise<ResourceMutationResult> { throw capabilityDenied("write", "session_file"); }
  async edit(_ref?: ResourceRef, _edits?: unknown[]): Promise<ResourceMutationResult> { throw capabilityDenied("edit", "session_file"); }
  async list(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("list", "session_file"); }
  async search(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("search", "session_file"); }
  async delete(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("delete", "session_file"); }
  async mkdir(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("mkdir", "session_file"); }

  resolveEntry(ref: ResourceRef) {
    if (ref.kind !== "session-file") {
      throw new ResourceIOError(`session_file provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    const entry = this.sessionFiles.get(ref.fileId, {
      sessionId: ref.sessionId || null,
      sessionPath: ref.sessionPath || null,
    });
    if (!entry) {
      throw new ResourceIOError(`session file not found: ${ref.fileId}`, {
        code: "resource_not_found",
        status: 404,
      });
    }
    if (entry.status === "expired") {
      throw new ResourceIOError(`session file expired: ${ref.fileId}`, {
        code: "resource_expired",
        status: 410,
      });
    }
    const filePath = entry.realPath || entry.filePath;
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new ResourceIOError(`session file path is invalid: ${ref.fileId}`, {
        code: "invalid_resource_path",
        status: 500,
      });
    }
    return { normalized: ref, entry, filePath };
  }
}

function descriptorForEntry(ref: Extract<ResourceRef, { kind: "session-file" }>, entry: any, filePath: string): ResourceDescriptor {
  return {
    kind: "session-file",
    fileId: ref.fileId,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
    ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    provider: "session_file",
    filePath,
    displayName: entry.displayName || entry.filename || path.basename(filePath),
  };
}

function statIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return null;
    throw err;
  }
}

function versionFromStat(stat: fs.Stats): ResourceVersion {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.isDirectory() ? null : stat.size,
  };
}
