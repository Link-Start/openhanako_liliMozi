import path from "path";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { createPluginConfigStore } from "./plugin-config.ts";

/**
 * Create a PluginContext for a plugin.
 * @param {{ pluginId: string, pluginKey?: string, source?: string, pluginDir: string, dataDir: string, bus: object, accessLevel?: "full-access" | "restricted", permissions?: string[], capabilities?: string[], sensitiveCapabilities?: string[], registerSessionFile?: Function, configSchema?: object, logSink?: Function, runtimeContext?: object }} opts
 */
export function createPluginContext({ pluginId, pluginKey, source, pluginDir, dataDir, bus, accessLevel, permissions, capabilities, sensitiveCapabilities, registerSessionFile: registerSessionFileImpl, configSchema, logSink, runtimeContext }) {
  const config = createPluginConfigStore({ dataDir, schema: configSchema });
  const runtimeScope = runtimeContext ? {
    serverId: runtimeContext.serverId,
    serverNodeId: runtimeContext.serverNodeId ?? runtimeContext.serverId,
    userId: runtimeContext.userId,
    studioId: runtimeContext.studioId,
    connectionKind: runtimeContext.connectionKind,
    credentialKind: runtimeContext.credentialKind,
    platformAccountId: runtimeContext.platformAccountId ?? null,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    executionBoundary: clonePlain(runtimeContext.executionBoundary),
  } : {};

  const resolvedAccess = accessLevel || "restricted";
  const grantedPermissions = normalizePermissions(permissions);
  const declaredCapabilities = normalizeCapabilityList(capabilities);
  const declaredSensitiveCapabilities = normalizeCapabilityList(sensitiveCapabilities);
  const pluginBus = resolvedAccess === "full-access"
    ? bus
    : createRestrictedBusProxy(bus, grantedPermissions);

  const prefix = `[plugin:${pluginId}]`;
  const recordLog = (level, args) => {
    if (typeof logSink !== "function") return;
    try {
      logSink({ pluginId, level, args, ts: new Date().toISOString() });
    } catch {
      // Logging must never break plugin execution.
    }
  };
  const log = {
    info: (...args) => { recordLog("info", args); console.log(prefix, ...args); },
    warn: (...args) => { recordLog("warn", args); console.warn(prefix, ...args); },
    error: (...args) => { recordLog("error", args); console.error(prefix, ...args); },
    debug: (...args) => { recordLog("debug", args); console.debug(prefix, ...args); },
  };

  function registerSessionFile(entry: any = {}) {
    if (typeof registerSessionFileImpl !== "function") {
      throw new Error("plugin session file registry unavailable");
    }
    const { sessionPath, filePath, label, origin = "plugin_output" } = entry;
    const storageKind = origin === "plugin_output" ? "plugin_data" : "external";
    if (!sessionPath) throw new Error("plugin registerSessionFile requires sessionPath");
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error("plugin registerSessionFile requires an absolute filePath");
    }
    return serializeSessionFile(registerSessionFileImpl({
      sessionPath,
      filePath,
      label,
      origin,
      storageKind,
    }), { runtimeContext: runtimeScope });
  }

  function toMediaItem(file) {
    return {
      type: "session_file",
      fileId: file.fileId || file.id,
      sessionPath: file.sessionPath,
      filePath: file.filePath,
      label: file.label || file.displayName || file.filename,
      ...(file.mime ? { mime: file.mime } : {}),
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.kind ? { kind: file.kind } : {}),
    };
  }

  function stageFile(entry: any = {}) {
    const { origin: _origin, storageKind: _storageKind, ...safeEntry } = entry;
    const file = registerSessionFile({ ...safeEntry, origin: "plugin_output" });
    return { file, mediaItem: toMediaItem(file) };
  }

  return {
    ...runtimeScope,
    pluginId,
    pluginKey: pluginKey || pluginId,
    source: source || "community",
    pluginDir,
    dataDir,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    bus: pluginBus,
    config,
    log,
    registerSessionFile,
    stageFile,
  };
}

function createRestrictedBusProxy(bus, grantedPermissions) {
  const canReadUsage = hasPermission(grantedPermissions, "usage.read");
  const getCapability = typeof bus.getCapability === "function"
    ? bus.getCapability.bind(bus)
    : () => null;
  const assertUsagePermission = (type, action) => {
    const capability = getCapability(type);
    if (capability?.permission !== "usage.read") return;
    if (canReadUsage) return;
    throw forbiddenBusError(type, action, "usage.read");
  };

  return Object.freeze({
    emit(event, sessionPath) {
      if (event?.type === "llm_usage") {
        throw forbiddenBusError("llm_usage", "emit", "usage.read");
      }
      return bus.emit(event, sessionPath);
    },
    subscribe(callback, filter = {}) {
      const requestedTypes = typesFromFilter(filter);
      if (!canReadUsage && requestedTypes?.has("llm_usage")) {
        throw forbiddenBusError("llm_usage", "subscribe", "usage.read");
      }
      const wrapped = (event, sessionPath) => {
        if (!canReadUsage && event?.type === "llm_usage") return;
        return callback(event, sessionPath);
      };
      return bus.subscribe(wrapped, filter);
    },
    async request(type, payload, options) {
      assertUsagePermission(type, "request");
      return bus.request(type, payload, options);
    },
    hasHandler: bus.hasHandler.bind(bus),
    listCapabilities: typeof bus.listCapabilities === "function" ? bus.listCapabilities.bind(bus) : () => [],
    getCapability,
  });
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return new Set();
  return new Set(permissions.filter((permission) => typeof permission === "string" && permission.trim()).map((permission) => permission.trim()));
}

function normalizeCapabilityList(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return [...new Set(capabilities
    .filter((capability) => typeof capability === "string" && capability.trim())
    .map((capability) => capability.trim()))];
}

function hasPermission(grantedPermissions, permission) {
  if (grantedPermissions.has("*")) return true;
  if (grantedPermissions.has(permission)) return true;
  const [namespace] = permission.split(".");
  return grantedPermissions.has(`${namespace}.*`);
}

function typesFromFilter(filter) {
  const types = filter?.types;
  if (types instanceof Set) return types;
  if (Array.isArray(types)) return new Set(types);
  return null;
}

function forbiddenBusError(type, action, permission) {
  const err: any = new Error(`Plugin bus ${action} "${type}" requires permission "${permission}"`);
  err.code = "FORBIDDEN";
  err.type = type;
  err.permission = permission;
  return err;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
