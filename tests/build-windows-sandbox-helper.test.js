import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  buildWindowsSandboxBatchScript,
  buildWindowsSandboxCompileCommand,
  shouldBuildWindowsSandboxHelper,
  windowsSandboxHelperOutputDir,
} from "../scripts/build-windows-sandbox-helper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Windows sandbox helper build script", () => {
  it("only builds on win32", () => {
    expect(shouldBuildWindowsSandboxHelper({ platform: "darwin" })).toBe(false);
    expect(shouldBuildWindowsSandboxHelper({ platform: "linux" })).toBe(false);
    expect(shouldBuildWindowsSandboxHelper({ platform: "win32" })).toBe(true);
  });

  it("writes the helper into the Electron extraResources source directory", () => {
    expect(windowsSandboxHelperOutputDir({
      rootDir: "/repo",
      arch: "x64",
    })).toBe(path.join("/repo", "dist-sandbox", "win-x64"));
  });

  it("links the Win32 libraries required by restricted tokens and ACL APIs", () => {
    const command = buildWindowsSandboxCompileCommand({
      source: "C:\\repo\\desktop\\native\\HanaWindowsSandboxHelper\\main.cpp",
      output: "C:\\repo\\dist-sandbox\\win-x64\\hana-win-sandbox.exe",
    });

    expect(command).toContain("cl.exe");
    expect(command).toContain("userenv.lib");
    expect(command).toContain("advapi32.lib");
  });

  it("uses restricted-token APIs instead of AppContainer launch APIs", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("CreateRestrictedToken");
    expect(source).toContain("WRITE_RESTRICTED");
    expect(source).toContain("CreateProcessAsUserW");
    expect(source).not.toContain("CreateAppContainerProfile");
    expect(source).not.toContain("PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES");
    expect(source).not.toContain("SECURITY_CAPABILITIES capabilities");
  });

  it("runs restricted-token children on a private desktop", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("CreateDesktopW");
    expect(source).toContain("CloseDesktop");
    expect(source).toContain("startup.StartupInfo.lpDesktop");
  });

  it("uses capability-style Hana write SIDs and exposes stale write ACL cleanup", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("S-1-15-3-4096-");
    expect(source).toContain("sidForWritableRootLegacyAccountNamespace");
    expect(source).toContain("--cleanup-hana-write-acl");
    expect(source).toContain("hana-write-acl-cleaned");
  });

  it("restores temporary write ACL changes after sandboxed commands", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("struct AclRestore");
    expect(source).toContain("restoreAcls");
    expect(source).toContain("applyWriteAcls(opts.writableRoots, opts.denyWritePaths, aclRestores)");
  });

  it("preserves the token default DACL owner context when adding write SIDs", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("queryTokenDefaultDacl");
    expect(source).toContain("SetEntriesInAclW(");
    expect(source).toContain("baseDefaultDacl");
  });

  it("restricts child handle inheritance to stdio handles", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(source).toContain("EXTENDED_STARTUPINFO_PRESENT");
    expect(source).toContain("setupInheritedHandleList");
  });

  it("canonicalizes existing paths through the Win32 final path API before comparing sandbox roots", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("GetFinalPathNameByHandleW");
    expect(source).toContain("FILE_FLAG_BACKUP_SEMANTICS");
    expect(source).toContain("normalizePathKey");
  });

  it("keeps a scoped legacy AppContainer diagnostic and cleanup path", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("--legacy-appcontainer-profile");
    expect(source).toContain("--cleanup-legacy-profile");
    expect(source).toContain("--diagnose-legacy-acl");
    expect(source).toContain("legacy-appcontainer-acl");
    expect(source).toContain("S-1-15-2-");
    expect(source).toContain("DeriveAppContainerSidFromAppContainerName");
    expect(source).toContain("DeleteAppContainerProfile");
    expect(source).toContain("REVOKE_ACCESS");
  });

  it("writes a batch script that calls VsDevCmd.bat before cl.exe", () => {
    const script = buildWindowsSandboxBatchScript({
      devCmd: "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat",
      compileCommand: "cl.exe /nologo main.cpp",
      arch: "x64",
    });

    expect(script).toBe([
      "@echo off",
      'call "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat" -arch=x64',
      "if errorlevel 1 exit /b %errorlevel%",
      "cl.exe /nologo main.cpp",
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"));
  });
});
