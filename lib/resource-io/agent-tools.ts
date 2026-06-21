import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeWin32ShellPath } from "../sandbox/win32-path.ts";

const RESOURCE_IO_FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pathParam(params) {
  if (!isObject(params)) return null;
  return nonEmptyString(params.path)
    || nonEmptyString(params.file_path)
    || nonEmptyString(params.filePath);
}

function normalizeLocalPath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function parseResourceString(value, cwd) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return { kind: "url", url: raw };
  }
  if (/^file:\/\//i.test(raw)) {
    return { kind: "local", path: fileURLToPath(raw) };
  }
  const sessionMatch = raw.match(/^(session-file|session_file|sessionfile):(.+)$/i);
  if (sessionMatch) {
    return { kind: "session-file", fileId: sessionMatch[2].trim() };
  }
  return { kind: "local", path: normalizeLocalPath(raw, cwd) };
}

function parseResourceObject(resource, cwd) {
  if (!isObject(resource)) return null;

  const kind = nonEmptyString(resource.kind) || nonEmptyString(resource.type) || nonEmptyString(resource.provider);
  const normalizedKind = kind ? kind.toLowerCase().replace(/_/g, "-") : "";
  if (normalizedKind === "url" || normalizedKind === "remote-url" || normalizedKind === "http") {
    const url = nonEmptyString(resource.url) || nonEmptyString(resource.href) || nonEmptyString(resource.uri);
    return url ? { kind: "url", url } : null;
  }
  if (normalizedKind === "session-file" || normalizedKind === "sessionfile") {
    const fileId = nonEmptyString(resource.fileId) || nonEmptyString(resource.id);
    const sessionPath = nonEmptyString(resource.sessionPath);
    return fileId ? { kind: "session-file", fileId, sessionPath } : null;
  }
  if (
    normalizedKind === "local"
    || normalizedKind === "local-path"
    || normalizedKind === "local-file"
    || normalizedKind === "path"
    || normalizedKind === "file"
    || normalizedKind === "local-fs"
  ) {
    const rawPath = nonEmptyString(resource.path)
      || nonEmptyString(resource.filePath)
      || nonEmptyString(resource.file_path);
    return rawPath ? { kind: "local", path: normalizeLocalPath(rawPath, cwd) } : null;
  }

  const uri = nonEmptyString(resource.uri) || nonEmptyString(resource.url);
  if (uri) return parseResourceString(uri, cwd);
  const rawPath = nonEmptyString(resource.path) || nonEmptyString(resource.filePath) || nonEmptyString(resource.file_path);
  if (rawPath) return { kind: "local", path: normalizeLocalPath(rawPath, cwd) };
  return null;
}

function resolveToolTarget(params, cwd) {
  if (!isObject(params)) return null;

  const resource = params.resource ?? params.ref ?? params.target;
  if (typeof resource === "string") {
    const parsed = parseResourceString(resource, cwd);
    if (parsed) return parsed;
  } else if (isObject(resource)) {
    const parsed = parseResourceObject(resource, cwd);
    if (parsed) return parsed;
  }

  const url = nonEmptyString(params.url) || nonEmptyString(params.href);
  if (url) return { kind: "url", url };

  const fileId = nonEmptyString(params.fileId);
  if (fileId) {
    return {
      kind: "session-file",
      fileId,
      sessionPath: nonEmptyString(params.sessionPath),
    };
  }

  const rawPath = pathParam(params);
  return rawPath ? { kind: "local", path: normalizeLocalPath(rawPath, cwd) } : null;
}

function stripResourceParams(params) {
  if (!isObject(params)) return params;
  const {
    resource: _resource,
    ref: _ref,
    target: _target,
    url: _url,
    href: _href,
    ...rest
  } = params;
  return rest;
}

function paramsForLocalTarget(params, absolutePath) {
  return {
    ...stripResourceParams(params),
    path: absolutePath,
  };
}

function removePathFromRequired(required) {
  if (!Array.isArray(required)) return required;
  return required.filter((name) => !["path", "file_path", "filePath"].includes(name));
}

function addResourceParameters(parameters, toolName) {
  if (!parameters || typeof parameters !== "object") return parameters;
  const properties = parameters.properties && typeof parameters.properties === "object"
    ? parameters.properties
    : {};
  return {
    ...parameters,
    required: removePathFromRequired(parameters.required),
    properties: {
      ...properties,
      resource: {
        type: "object",
        description: "Optional ResourceIO target. Use { kind: 'local-file', path }, { kind: 'session-file', fileId }, or { kind: 'url', url }. Existing path/fileId/url parameters also work.",
        additionalProperties: true,
      },
      url: {
        type: "string",
        description: toolName === "read"
          ? "Optional URL to read as text through ResourceIO. URLs are read-only."
          : "URL targets are read-only and are rejected by this tool.",
      },
      fileId: {
        type: "string",
        description: toolName === "read"
          ? "SessionFile id to resolve for reading. SessionFile is a reference, not a writable filesystem."
          : "SessionFile ids are references and cannot be written or edited directly.",
      },
      sessionPath: {
        type: "string",
        description: "Optional session JSONL path that owns fileId. Usually omit to use the current session.",
      },
    },
  };
}

function statSnapshot(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      version: `${Math.round(stat.mtimeMs)}:${stat.size}`,
    };
  } catch {
    return null;
  }
}

function snapshotChanged(before, after) {
  if (!after) return false;
  if (!before) return true;
  return before.mtimeMs !== after.mtimeMs || before.size !== after.size;
}

function emitResourceChanged(options, target, reason) {
  if (typeof options.emitEvent !== "function" || !target?.path) return;
  const sessionPath = options.getSessionPath?.() || null;
  const stat = statSnapshot(target.path);
  options.emitEvent({
    type: "resource.changed",
    source: "agent_tool",
    reason,
    sessionPath,
    filePath: target.path,
    resource: {
      kind: "local-file",
      provider: "local_fs",
      path: target.path,
    },
    ...(stat ? { mtimeMs: stat.mtimeMs, size: stat.size, version: stat.version } : {}),
  }, sessionPath);
}

async function readUrlAsText(url, resourceIO) {
  if (!resourceIO || typeof resourceIO.read !== "function") {
    return textResult("ResourceIO URL reads require the ResourceIO kernel.");
  }
  const result = await resourceIO.read({ kind: "url", url });
  const text = Buffer.isBuffer(result.content)
    ? result.content.toString("utf-8")
    : Buffer.from(result.content || "").toString("utf-8");
  return textResult([
    `URL: ${url}`,
    result.version?.etag ? `ETag: ${result.version.etag}` : null,
    "",
    text,
  ].filter((part) => part !== null).join("\n"));
}

function wrapResourceIoTool(tool, options) {
  const toolName = tool?.name;
  if (!RESOURCE_IO_FILE_TOOL_NAMES.has(toolName)) return tool;

  return {
    ...tool,
    parameters: addResourceParameters(tool.parameters, toolName),
    execute: async (toolCallId, params = {}, ...rest) => {
      const target: any = resolveToolTarget(params, options.cwd);
      if (!target) return tool.execute(toolCallId, params, ...rest);

      if (target.kind === "url") {
        if (toolName === "read") return readUrlAsText(target.url, options.resourceIO);
        return textResult(`ResourceIO URL targets are read-only; ${toolName} cannot operate on ${target.url}.`);
      }

      if (target.kind === "session-file") {
        if (toolName === "read") {
          if (!options.resourceIO || typeof options.resourceIO.materialize !== "function") {
            return textResult("SessionFile reads require the ResourceIO kernel.");
          }
          const materialized = await options.resourceIO.materialize({
            kind: "session-file",
            fileId: target.fileId,
            ...(target.sessionPath ? { sessionPath: target.sessionPath } : {}),
          });
          return tool.execute(toolCallId, paramsForLocalTarget(params, materialized.filePath), ...rest);
        }
        return textResult(`SessionFile ${target.fileId} is a reference and cannot be written or edited directly. Resolve or materialize it to a local path first.`);
      }

      if (!target.path) return tool.execute(toolCallId, params, ...rest);

      const normalizedParams = paramsForLocalTarget(params, target.path);
      if (!WRITE_TOOL_NAMES.has(toolName)) {
        return tool.execute(toolCallId, normalizedParams, ...rest);
      }

      const before = statSnapshot(target.path);
      const result = await tool.execute(toolCallId, normalizedParams, ...rest);
      const after = statSnapshot(target.path);
      if (!options.resourceIO && snapshotChanged(before, after)) {
        emitResourceChanged(options, target, toolName === "write" ? "agent_write" : "agent_edit");
      }
      return result;
    },
  };
}

function dedupeToolsByName(tools) {
  const seen = new Set();
  return tools.filter((tool) => {
    const name = tool?.name;
    if (!name) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function wrapResourceIoFileTools(tools, options) {
  if (!Array.isArray(tools)) return tools;
  return dedupeToolsByName(tools.map((tool) => wrapResourceIoTool(tool, options)));
}

export const __resourceIoAgentToolsForTest = {
  resolveToolTarget,
  addResourceParameters,
};
