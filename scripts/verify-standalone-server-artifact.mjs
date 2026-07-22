#!/usr/bin/env node
/**
 * Fail-closed verification for the Windows HanaCore standalone release asset.
 * Verification happens after packaging and before CI uploads anything.
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

import { assertRuntimeComplete, MINGIT_VERSION } from "./mingit-runtime.js";
import { createHermeticMinGitSmokeEnv } from "./smoke-mingit.mjs";
import {
  REQUIRED_STANDALONE_SERVER_FILES,
  ROOT,
  STANDALONE_ARCH,
  STANDALONE_LAYOUT_ROOT,
  STANDALONE_PLATFORM,
  readProductVersion,
  standaloneArtifactNames,
  standaloneWrapperContents,
} from "./build-standalone-server-artifact.mjs";

const require = createRequire(import.meta.url);
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const __filename = fileURLToPath(import.meta.url);

function assertFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`[verify-standalone] ${label} is missing: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[verify-standalone] ${label} must be a file: ${filePath}`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `[verify-standalone] ${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertExtractedLayout(layoutRoot) {
  const expectedRootEntries = ["git", "hana-server.cmd", "hana.cmd", "sandbox", "server"];
  const actualRootEntries = fs.readdirSync(layoutRoot).sort();
  expectEqual(JSON.stringify(actualRootEntries), JSON.stringify(expectedRootEntries), "archive root entries");

  for (const relative of REQUIRED_STANDALONE_SERVER_FILES) {
    assertFile(path.join(layoutRoot, "server", ...relative.split("/")), `packaged server file ${relative}`);
  }
  assertFile(
    path.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe"),
    "Windows sandbox helper",
  );
  try {
    assertRuntimeComplete(path.join(layoutRoot, "git"));
  } catch (error) {
    throw new Error(`[verify-standalone] extracted MinGit runtime is incomplete\n${error.message}`);
  }

  const wrappers = standaloneWrapperContents();
  expectEqual(fs.readFileSync(path.join(layoutRoot, "hana.cmd"), "utf8"), wrappers.hana, "hana.cmd");
  expectEqual(
    fs.readFileSync(path.join(layoutRoot, "hana-server.cmd"), "utf8"),
    wrappers.server,
    "hana-server.cmd",
  );
}

function envValue(env, name) {
  const match = Object.entries(env || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ? String(match[1]) : "";
}

/**
 * Build the helper-child environment for the restricted-token release smoke.
 * Production win32-exec materializes TEMP/LOCALAPPDATA/APPDATA under a writable
 * ephemeral root and starts from a near-complete process env. This smoke keeps
 * Path native-only (no MinGit/MSYS) so it proves helper + writable/deny-write
 * without borrowing host Git or forcing MSYS DLLs into the child.
 */
export function createRestrictedTokenSmokeRuntimeEnv({
  workDir,
  hanaHome,
  helperPath,
  layoutRoot,
  env = process.env,
} = {}) {
  if (!workDir) throw new Error("workDir is required");
  if (!hanaHome) throw new Error("hanaHome is required");
  if (!helperPath) throw new Error("helperPath is required");
  if (!layoutRoot) throw new Error("layoutRoot is required");

  const systemRoot = envValue(env, "SystemRoot") || envValue(env, "WINDIR") || "C:\\Windows";
  const runtimeEnvRoot = path.win32.join(workDir, ".ephemeral", "win32-sandbox-env");
  const tempDir = path.win32.join(runtimeEnvRoot, "Temp");
  const localAppDataDir = path.win32.join(runtimeEnvRoot, "LocalAppData");
  const appDataDir = path.win32.join(runtimeEnvRoot, "AppData", "Roaming");
  const profileDir = path.win32.join(workDir, "Profile");
  const smokeEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: envValue(env, "ComSpec") || path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
    Path: path.win32.join(systemRoot, "System32"),
    TEMP: tempDir,
    TMP: tempDir,
    LOCALAPPDATA: localAppDataDir,
    APPDATA: appDataDir,
    USERPROFILE: profileDir,
    HOME: profileDir,
    HANA_HOME: hanaHome,
    HANA_ROOT: path.win32.join(layoutRoot, "server"),
    HANA_SERVER_ENTRY: path.win32.join(layoutRoot, "server", "bundle", "index.js"),
    HANA_WIN32_SANDBOX_HELPER: helperPath,
    HANA_WIN32_SANDBOX_DEBUG: "1",
  };

  // Carry the small set of host identity/system keys production inherits, but
  // never host PATH/NODE_OPTIONS (those are how CI Git and injectors leak in).
  for (const key of [
    "SystemDrive",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "COMPUTERNAME",
    "PUBLIC",
    "ProgramData",
  ]) {
    const value = envValue(env, key);
    if (value) smokeEnv[key] = value;
  }

  return {
    env: smokeEnv,
    runtimeDirs: [tempDir, localAppDataDir, appDataDir, profileDir],
  };
}

export function standaloneRestrictedTokenSmokeSpec({
  layoutRoot,
  workDir,
  hanaHome,
  helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe"),
  env = process.env,
}) {
  const { env: smokeEnv, runtimeDirs } = createRestrictedTokenSmokeRuntimeEnv({
    workDir,
    hanaHome,
    helperPath,
    layoutRoot,
    env,
  });
  const markerFileName = "hana-restricted-token-smoke.txt";
  const blockedDirName = "blocked";
  const deniedFileName = "hana-deny-write-smoke.txt";
  // The child must be a native PE binary: MSYS/Cygwin programs such as
  // usr/bin/sh.exe fail to initialize (STATUS_DLL_INIT_FAILED) under a
  // restricted token, so cmd.exe carries the writable-root and deny-write
  // proof. Sandboxed Git startup is covered by the exec_command smoke below,
  // which reaches it through the production exec chain.
  const shellCommand =
    `echo HANA_RESTRICTED_TOKEN_OK>${markerFileName}`
    + ` && type ${markerFileName}`
    + ` && (echo SHOULD_NOT_WRITE>${blockedDirName}\\${deniedFileName})`
    + " && exit 73"
    + " || echo HANA_DENY_WRITE_OK";
  const powerShellPath = path.win32.join(
    smokeEnv.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powerShellCommand =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
    + "$OutputEncoding = [Console]::OutputEncoding; "
    + "Write-Output HANA_RESTRICTED_POWERSHELL_OK";
  const encodedPowerShellCommand = Buffer.from(powerShellCommand, "utf16le").toString("base64");
  return {
    helperPath,
    markerPath: path.win32.join(workDir, markerFileName),
    blockedDir: path.win32.join(workDir, blockedDirName),
    deniedMarkerPath: path.win32.join(workDir, blockedDirName, deniedFileName),
    runtimeDirs,
    env: smokeEnv,
    args: [
      "--cwd", workDir,
      "--writable-root", workDir,
      "--deny-write", path.win32.join(workDir, blockedDirName),
      "--timeout-ms", "30000",
      "--",
      smokeEnv.ComSpec,
      "/d", "/s", "/c",
      shellCommand,
    ],
    powerShellArgs: [
      "--cwd", workDir,
      "--writable-root", workDir,
      "--timeout-ms", "15000",
      "--",
      powerShellPath,
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodedPowerShellCommand,
    ],
  };
}

export function runRestrictedTokenHelperSmoke({
  layoutRoot,
  workDir,
  hanaHome,
  helperPath,
  env = process.env,
  spawnSyncImpl = spawnSync,
}) {
  const spec = standaloneRestrictedTokenSmokeSpec({ layoutRoot, workDir, hanaHome, helperPath, env });
  fs.mkdirSync(spec.blockedDir, { recursive: true });
  for (const dir of spec.runtimeDirs || []) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sandboxResult = spawnSyncImpl(
    spec.helperPath,
    spec.args,
    restrictedTokenSmokeSpawnOptions({ cwd: workDir, env: spec.env, timeout: 45_000 }),
  );
  if (sandboxResult.error || sandboxResult.status !== 0) {
    throw new Error(
      "[verify-standalone] restricted-token sandbox smoke failed"
        + ` (status=${String(sandboxResult.status)}, signal=${String(sandboxResult.signal)})`
        + (sandboxResult.error ? `: ${sandboxResult.error.message}` : "")
        + (sandboxResult.stderr ? `\nstderr: ${sandboxResult.stderr.trim()}` : ""),
    );
  }
  const smokeStdout = String(sandboxResult.stdout || "");
  const smokeStderr = String(sandboxResult.stderr || "");
  if (!smokeStdout.includes("HANA_RESTRICTED_TOKEN_OK")) {
    throw new Error("[verify-standalone] restricted-token sandbox smoke did not emit its success marker");
  }
  if (!smokeStdout.includes("HANA_DENY_WRITE_OK")) {
    throw new Error("[verify-standalone] restricted-token sandbox smoke did not prove deny-write enforcement");
  }
  const terminalRecord = 'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="30000" win32Error="0"';
  if (!smokeStderr.includes(terminalRecord)) {
    throw new Error(
      `[verify-standalone] restricted-token sandbox smoke emitted no successful terminal record\nstderr: ${smokeStderr.trim()}`,
    );
  }
  expectEqual(
    fs.readFileSync(spec.markerPath, "utf8").trim(),
    "HANA_RESTRICTED_TOKEN_OK",
    "restricted-token writable-root marker",
  );
  if (fs.existsSync(spec.deniedMarkerPath)) {
    throw new Error("[verify-standalone] restricted-token sandbox wrote inside an explicit deny-write path");
  }

  const powerShellResult = spawnSyncImpl(
    spec.helperPath,
    spec.powerShellArgs,
    restrictedTokenSmokeSpawnOptions({ cwd: workDir, env: spec.env, timeout: 25_000 }),
  );
  if (powerShellResult.error || powerShellResult.status !== 0) {
    throw new Error(
      "[verify-standalone] restricted-token PowerShell smoke failed"
        + ` (status=${String(powerShellResult.status)}, signal=${String(powerShellResult.signal)})`
        + (powerShellResult.error ? `: ${powerShellResult.error.message}` : "")
        + (powerShellResult.stdout ? `\nstdout: ${powerShellResult.stdout.trim()}` : "")
        + (powerShellResult.stderr ? `\nstderr: ${powerShellResult.stderr.trim()}` : ""),
    );
  }
  const powerShellStdout = String(powerShellResult.stdout || "");
  const powerShellStderr = String(powerShellResult.stderr || "");
  if (!powerShellStdout.includes("HANA_RESTRICTED_POWERSHELL_OK")) {
    throw new Error("[verify-standalone] restricted-token PowerShell smoke did not emit its success marker");
  }
  const powerShellTerminalRecord =
    'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="15000" win32Error="0"';
  if (!powerShellStderr.includes(powerShellTerminalRecord)) {
    throw new Error(
      `[verify-standalone] restricted-token PowerShell smoke emitted no successful terminal record\nstderr: ${powerShellStderr.trim()}`,
    );
  }
  return spec;
}

export function restrictedTokenSmokeSpawnOptions({ cwd, env, timeout }) {
  return {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    // Production one-shot execution gives the helper a closed stdin. Keep the
    // smoke on the same contract: Windows PowerShell 5.1 may wait indefinitely
    // for an inherited pipe whose writer stays open in the intermediary parent.
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  };
}

export function standaloneExecCommandSmokeSpec({ layoutRoot, workDir, hanaHome, env = process.env }) {
  const baseEnv = createHermeticMinGitSmokeEnv({
    runtimeRoot: path.win32.join(layoutRoot, "git"),
    workRoot: hanaHome,
    env,
  });
  const helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe");
  const serverRoot = path.win32.join(layoutRoot, "server");
  return {
    command: baseEnv.ComSpec,
    args: ["/d", "/s", "/c", `call "${path.win32.join(layoutRoot, "hana-server.cmd")}"`],
    // cmd.exe parses its raw command line instead of CommandLineToArgvW output.
    // Letting libuv quote the final /c argument turns the inner batch-file
    // quotes into literal \" characters, so cmd tries to execute a filename
    // that includes quotes. The command is fully generated here; preserve it
    // verbatim so `call "...\\hana-server.cmd"` reaches cmd.exe unchanged.
    windowsVerbatimArguments: true,
    env: {
      ...baseEnv,
      HANA_HOME: hanaHome,
      // Poison values prove the extracted wrapper, rather than the verifier,
      // owns the packaged runtime contract before Node imports the probe.
      HANA_ROOT: "Z:\\hana-poison\\server",
      HANA_SERVER_ENTRY: "Z:\\hana-poison\\server\\bundle\\index.js",
      HANA_WIN32_SANDBOX_HELPER: "Z:\\hana-poison\\sandbox\\hana-win-sandbox.exe",
      HANA_INTERNAL_STANDALONE_RUNTIME_SMOKE: "1",
      HANA_STANDALONE_EXEC_WORK: workDir,
      HANA_STANDALONE_EXPECTED_HELPER: helperPath,
      HANA_STANDALONE_EXPECTED_ROOT: serverRoot,
    },
  };
}

function smokeExtractedRuntime({ rootDir, layoutRoot }) {
  if (process.platform !== "win32") {
    throw new Error("[verify-standalone] --smoke is Windows-only because the archive contains Windows executables");
  }

  execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "smoke-mingit.mjs"), path.join(layoutRoot, "git")],
    { stdio: "inherit" },
  );

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-standalone-runtime-"));
  const smokeHome = path.join(smokeRoot, "hana-home");
  const workDir = path.join(smokeRoot, "work");
  fs.mkdirSync(smokeHome, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(smokeHome, "agents", "standalone-smoke"), { recursive: true });
  try {
    runRestrictedTokenHelperSmoke({ layoutRoot, workDir, hanaHome: smokeHome });

    const execSpec = standaloneExecCommandSmokeSpec({
      layoutRoot,
      workDir,
      hanaHome: smokeHome,
    });
    const execResult = spawnSync(execSpec.command, execSpec.args, {
      cwd: layoutRoot,
      env: execSpec.env,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: execSpec.windowsVerbatimArguments,
      timeout: 90_000,
    });
    if (execResult.error || execResult.status !== 0) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke failed"
          + ` (status=${String(execResult.status)}, signal=${String(execResult.signal)})`
          + (execResult.error ? `: ${execResult.error.message}` : "")
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const receiptPrefix = "HANA_STANDALONE_EXEC_RECEIPT=";
    const receiptLine = String(execResult.stdout || "")
      .split(/\r?\n/)
      .find((line) => line.startsWith(receiptPrefix));
    if (!receiptLine) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke emitted no receipt"
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const execReceipt = JSON.parse(receiptLine.slice(receiptPrefix.length));
    expectEqual(execReceipt.ok, true, "exec_command packaged-runtime smoke status");
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   rootDir?: string,
 *   version?: string,
 *   arch?: string,
 *   artifactOutDir?: string,
 *   smoke?: boolean,
 *   log?: (message: string) => void,
 * }} opts
 */
export async function verifyWindowsStandaloneArtifact(opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? ROOT);
  const version = opts.version ?? readProductVersion(rootDir);
  const arch = opts.arch ?? STANDALONE_ARCH;
  const artifactOutDir = path.resolve(opts.artifactOutDir ?? path.join(rootDir, "dist-standalone"));
  const names = standaloneArtifactNames(version, arch);
  const archivePath = path.join(artifactOutDir, names.archiveName);
  const manifestPath = path.join(artifactOutDir, names.manifestName);
  const legacySignaturePath = `${manifestPath}.sig`;
  const log = opts.log ?? console.log;

  assertFile(archivePath, "standalone archive");
  assertFile(manifestPath, "standalone manifest");
  if (fs.existsSync(legacySignaturePath)) {
    throw new Error(
      `[verify-standalone] obsolete standalone manifest signature must be removed: ${legacySignaturePath}`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  expectEqual(manifest.schema, 1, "manifest schema");
  expectEqual(manifest.kind, "hana-core-standalone", "manifest kind");
  expectEqual(manifest.version, version, "manifest version");
  expectEqual(manifest.platform, STANDALONE_PLATFORM, "manifest platform");
  expectEqual(manifest.arch, arch, "manifest architecture");
  expectEqual(manifest.archive?.path, names.archiveName, "manifest archive path");
  expectEqual(manifest.layout?.root, STANDALONE_LAYOUT_ROOT, "manifest layout root");
  expectEqual(manifest.layout?.server, `${STANDALONE_LAYOUT_ROOT}/server`, "manifest server layout");
  expectEqual(manifest.layout?.git, `${STANDALONE_LAYOUT_ROOT}/git`, "manifest Git layout");
  expectEqual(
    manifest.layout?.sandboxHelper,
    `${STANDALONE_LAYOUT_ROOT}/sandbox/windows/hana-win-sandbox.exe`,
    "manifest sandbox helper layout",
  );
  expectEqual(manifest.runtime?.minGitVersion, MINGIT_VERSION, "manifest MinGit version");

  const actualSha256 = await activation.sha256File(archivePath);
  const actualSize = fs.statSync(archivePath).size;
  expectEqual(manifest.archive?.sha256, actualSha256, "archive sha256");
  expectEqual(manifest.archive?.size, actualSize, "archive size");

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-standalone-verify-"));
  try {
    await ustar.extract(archivePath, extractDir);
    const layoutRoot = path.join(extractDir, STANDALONE_LAYOUT_ROOT);
    const rootStat = fs.statSync(layoutRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`[verify-standalone] archive layout root must be a directory: ${layoutRoot}`);
    }
    assertExtractedLayout(layoutRoot);
    if (opts.smoke) smokeExtractedRuntime({ rootDir, layoutRoot });
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  log(`[verify-standalone] verified ${names.archiveName}`);
  return { archivePath, manifestPath, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const arch = args.find((arg) => !arg.startsWith("--")) ?? STANDALONE_ARCH;
  await verifyWindowsStandaloneArtifact({ arch, smoke: args.includes("--smoke") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
