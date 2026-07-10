
import { existsSync as defaultExistsSync } from "fs";
import path from "path";

export const WIN32_SANDBOX_HELPER_NAME = "hana-win-sandbox.exe";
export const WIN32_SANDBOX_TERMINAL_PREFIX = "hana-win-sandbox: terminal-v1";
export const WIN32_SANDBOX_MAX_TIMEOUT_MS = 0xFFFFFFFE;

export type Win32SandboxTerminalStatus =
  | "exited"
  | "timed_out"
  | "termination_failed"
  | "launch_failed";

export interface Win32SandboxTerminalRecord {
  version: 1;
  status: Win32SandboxTerminalStatus;
  exitCode: number | null;
  timeoutMs: number;
  win32Error: number;
}

export interface Win32SandboxTerminalStderrFilter {
  push(data: Buffer | Uint8Array | string): void;
  flush(): void;
  readonly terminalRecord: Win32SandboxTerminalRecord | null;
}

export function resourceSiblingDir(name, { env = process.env, resourcesPath = (process as any).resourcesPath } = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, name));
  if (env.HANA_ROOT) candidates.push(path.resolve(env.HANA_ROOT, "..", name));
  return candidates.find((candidate) => defaultExistsSync(candidate)) || candidates[0] || null;
}

export function resolveWin32SandboxHelper({
  env = process.env,
  resourcesPath = (process as any).resourcesPath,
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
  timeoutMs = 0,
  grants = {},
  executable,
  args = [],
}: {
  cwd?: string;
  timeoutMs?: number;
  grants?: Record<string, any>;
  executable?: string;
  args?: string[];
} = {}) {
  if (!cwd) throw new Error("win32 sandbox helper requires cwd");
  if (!executable) throw new Error("win32 sandbox helper requires executable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > WIN32_SANDBOX_MAX_TIMEOUT_MS) {
    throw new Error(`win32 sandbox helper timeoutMs must be an integer between 0 and ${WIN32_SANDBOX_MAX_TIMEOUT_MS}`);
  }

  const out = ["--cwd", cwd];
  for (const p of grants.writePaths || []) out.push("--writable-root", p);
  for (const p of grants.optionalWritePaths || []) out.push("--writable-root-optional", p);
  for (const p of grants.denyWritePaths || []) out.push("--deny-write", p);
  out.push("--timeout-ms", String(timeoutMs));
  out.push("--", executable, ...args);
  return out;
}

export function buildWin32SandboxTokenDiagnosticArgs(options = {}) {
  return ["--diagnose-token", ...buildWin32SandboxHelperArgs(options)];
}

function parseWin32SandboxTerminalRecordLine(line: string): Win32SandboxTerminalRecord | null {
  const match = line.match(
    /^hana-win-sandbox: terminal-v1 status="([^"]*)" exitCode="([^"]*)" timeoutMs="([^"]*)" win32Error="([^"]*)"$/,
  );
  if (!match) return null;
  const status = match[1] as Win32SandboxTerminalStatus;
  if (status !== "exited" && status !== "timed_out" && status !== "termination_failed" && status !== "launch_failed") {
    return null;
  }
  const exitCode = match[2] === "" ? null : Number(match[2]);
  const timeoutMs = Number(match[3]);
  const win32Error = Number(match[4]);
  if ((exitCode !== null && !Number.isSafeInteger(exitCode))
    || !Number.isSafeInteger(timeoutMs)
    || !Number.isSafeInteger(win32Error)) {
    return null;
  }
  return { version: 1, status, exitCode, timeoutMs, win32Error };
}

export function parseWin32SandboxTerminalRecord(output: unknown): Win32SandboxTerminalRecord | null {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "");
  let last: Win32SandboxTerminalRecord | null = null;
  for (const line of text.split(/\r?\n/)) {
    const record = parseWin32SandboxTerminalRecordLine(line);
    if (record) last = record;
  }
  return last;
}

export function createWin32SandboxTerminalStderrFilter({
  onData,
}: {
  onData: (data: Buffer) => void;
}): Win32SandboxTerminalStderrFilter {
  let pending = Buffer.alloc(0);
  let terminalRecord: Win32SandboxTerminalRecord | null = null;
  let flushed = false;

  const consumeLine = (lineWithNewline: Buffer) => {
    let bodyEnd = lineWithNewline.length;
    if (bodyEnd > 0 && lineWithNewline[bodyEnd - 1] === 0x0A) bodyEnd -= 1;
    if (bodyEnd > 0 && lineWithNewline[bodyEnd - 1] === 0x0D) bodyEnd -= 1;
    const record = parseWin32SandboxTerminalRecordLine(
      lineWithNewline.subarray(0, bodyEnd).toString("utf8"),
    );
    if (record) {
      terminalRecord = record;
      return;
    }
    if (lineWithNewline.length > 0) onData(lineWithNewline);
  };

  return {
    push(data) {
      if (flushed) throw new Error("win32 sandbox terminal stderr filter is already flushed");
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length === 0) return;
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      let newlineIndex = pending.indexOf(0x0A);
      while (newlineIndex >= 0) {
        consumeLine(pending.subarray(0, newlineIndex + 1));
        pending = pending.subarray(newlineIndex + 1);
        newlineIndex = pending.indexOf(0x0A);
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      if (pending.length > 0) consumeLine(pending);
      pending = Buffer.alloc(0);
    },
    get terminalRecord() {
      return terminalRecord;
    },
  };
}
