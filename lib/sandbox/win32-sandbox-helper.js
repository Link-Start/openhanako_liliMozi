import { existsSync as defaultExistsSync } from "fs";
import path from "path";

export const WIN32_SANDBOX_HELPER_NAME = "hana-win-sandbox.exe";

export function resourceSiblingDir(name, { env = process.env, resourcesPath = process.resourcesPath } = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, name));
  if (env.HANA_ROOT) candidates.push(path.resolve(env.HANA_ROOT, "..", name));
  return candidates.find((candidate) => defaultExistsSync(candidate)) || candidates[0] || null;
}

export function resolveWin32SandboxHelper({
  env = process.env,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  arch = process.arch,
  existsSync = defaultExistsSync,
} = {}) {
  const candidates = [
    env.HANA_WIN32_SANDBOX_HELPER,
    resourcesPath ? path.join(resourcesPath, "sandbox", "windows", WIN32_SANDBOX_HELPER_NAME) : null,
    env.HANA_ROOT ? path.resolve(env.HANA_ROOT, "..", "sandbox", "windows", WIN32_SANDBOX_HELPER_NAME) : null,
    path.join(cwd, "dist-sandbox", `win-${arch}`, WIN32_SANDBOX_HELPER_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function buildWin32SandboxHelperArgs({
  cwd,
  grants = {},
  executable,
  args = [],
} = {}) {
  if (!cwd) throw new Error("win32 sandbox helper requires cwd");
  if (!executable) throw new Error("win32 sandbox helper requires executable");

  const out = ["--cwd", cwd];
  for (const p of grants.writePaths || []) out.push("--writable-root", p);
  for (const p of grants.optionalWritePaths || []) out.push("--writable-root-optional", p);
  for (const p of grants.denyWritePaths || []) out.push("--deny-write", p);
  out.push("--", executable, ...args);
  return out;
}

export function buildWin32LegacyAclDiagnosticArgs({ paths = [], cleanup = false } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("win32 legacy ACL diagnostic requires at least one path");
  }
  const out = [];
  if (cleanup) out.push("--cleanup-legacy-acl");
  for (const p of paths) {
    if (!p) continue;
    out.push("--diagnose-legacy-acl", p);
  }
  if (!out.some((arg) => arg === "--diagnose-legacy-acl")) {
    throw new Error("win32 legacy ACL diagnostic requires at least one path");
  }
  return out;
}

export function buildWin32HanaWriteAclCleanupArgs({ paths = [] } = {}) {
  const targets = [...new Set((paths || []).filter(Boolean))];
  if (targets.length === 0) {
    throw new Error("win32 Hana write ACL cleanup requires at least one path");
  }
  const out = [];
  for (const p of targets) {
    out.push("--cleanup-hana-write-acl", p);
  }
  return out;
}

export function buildWin32LegacyProfileCleanupArgs({ profileNames = [] } = {}) {
  const names = [...new Set((profileNames || []).filter(Boolean))];
  if (names.length === 0) {
    throw new Error("win32 legacy profile cleanup requires at least one profile name");
  }
  const out = [];
  for (const name of names) {
    out.push("--cleanup-legacy-profile", name);
  }
  return out;
}
