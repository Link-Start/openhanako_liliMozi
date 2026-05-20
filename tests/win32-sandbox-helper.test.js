import { describe, expect, it } from "vitest";
import {
  buildWin32HanaWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
  buildWin32SandboxHelperArgs,
} from "../lib/sandbox/win32-sandbox-helper.js";

describe("buildWin32SandboxHelperArgs", () => {
  it("projects the helper contract as write roots instead of read ACL grants", () => {
    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      executable: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc", "curl https://example.com"],
      grants: {
        readPaths: ["C:\\outside\\brief.md"],
        optionalReadPaths: ["C:\\Users\\Hana"],
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        denyReadPaths: ["C:\\Users\\Hana\\.hanako\\auth.json"],
        denyWritePaths: ["C:\\work\\.git"],
      },
    })).toEqual([
      "--cwd",
      "C:\\work",
      "--writable-root",
      "C:\\work",
      "--writable-root-optional",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "--deny-write",
      "C:\\work\\.git",
      "--",
      "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      "-lc",
      "curl https://example.com",
    ]);
  });

  it("builds a legacy AppContainer ACL diagnostic command without executable passthrough", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      paths: ["C:\\work", "C:\\Users\\Hana\\.hanako\\.ephemeral"],
    })).toEqual([
      "--diagnose-legacy-acl",
      "C:\\work",
      "--diagnose-legacy-acl",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
  });

  it("can request explicit legacy AppContainer ACL cleanup", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      cleanup: true,
      paths: ["C:\\work"],
    })).toEqual([
      "--cleanup-legacy-acl",
      "--diagnose-legacy-acl",
      "C:\\work",
    ]);
  });

  it("builds stale Hana write ACL cleanup commands without executable passthrough", () => {
    expect(buildWin32HanaWriteAclCleanupArgs({
      paths: ["C:\\work", "C:\\Users\\Hana\\.hanako\\.ephemeral"],
    })).toEqual([
      "--cleanup-hana-write-acl",
      "C:\\work",
      "--cleanup-hana-write-acl",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
  });

  it("builds explicit legacy AppContainer profile cleanup commands", () => {
    expect(buildWin32LegacyProfileCleanupArgs({
      profileNames: [
        "com.hanako.sandbox.1288.475900",
        "com.hanako.sandbox.5104.475988",
      ],
    })).toEqual([
      "--cleanup-legacy-profile",
      "com.hanako.sandbox.1288.475900",
      "--cleanup-legacy-profile",
      "com.hanako.sandbox.5104.475988",
    ]);
  });
});
