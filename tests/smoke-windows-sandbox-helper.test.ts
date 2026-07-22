import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  smokeWindowsSandboxHelper,
  windowsSandboxHelperPath,
} from "../scripts/smoke-windows-sandbox-helper.mjs";
import {
  restrictedTokenSmokeSpawnOptions,
  standaloneRestrictedTokenSmokeSpec,
} from "../scripts/verify-standalone-server-artifact.mjs";

describe("Windows sandbox helper CI smoke", () => {
  it("resolves the helper produced by the native helper build", () => {
    expect(windowsSandboxHelperPath({ rootDir: "C:\\repo", arch: "x64" }))
      .toBe(path.join("C:\\repo", "dist-sandbox", "win-x64", "hana-win-sandbox.exe"));
  });

  it("fails explicitly outside a Windows runner", () => {
    expect(() => smokeWindowsSandboxHelper({ platform: "darwin" }))
      .toThrow(/requires a Windows runner/);
  });

  it("fails explicitly when the built helper is absent", () => {
    expect(() => smokeWindowsSandboxHelper({
      rootDir: path.join(path.sep, "definitely-missing-hana-helper"),
      platform: "win32",
    })).toThrow(/helper is missing/);
  });

  it("runs PowerShell directly with the restricted helper on the private desktop", () => {
    const spec = standaloneRestrictedTokenSmokeSpec({
      layoutRoot: "C:\\HanaCore",
      workDir: "C:\\smoke\\work",
      hanaHome: "C:\\smoke\\home",
      helperPath: "C:\\HanaCore\\sandbox\\windows\\hana-win-sandbox.exe",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spec.env.HANA_WIN32_SANDBOX_DEBUG).toBe("1");
    expect(spec.powerShellArgs).not.toContain("--current-desktop");
    expect(spec.powerShellArgs).not.toContain("--verbatim-last-arg");
    expect(spec.powerShellArgs).toContain(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spec.powerShellArgs).not.toContain("C:\\Windows\\System32\\cmd.exe");
    expect(spec.powerShellArgs).toContain("-EncodedCommand");
    const decodedCommand = Buffer.from(spec.powerShellArgs.at(-1) || "", "base64").toString("utf16le");
    expect(decodedCommand).toContain("HANA_RESTRICTED_POWERSHELL_OK");
  });

  it("keeps restricted helper smoke stdin closed like production one-shot execution", () => {
    expect(restrictedTokenSmokeSpawnOptions({
      cwd: "C:\\smoke\\work",
      env: { SystemRoot: "C:\\Windows" },
      timeout: 25_000,
    })).toMatchObject({
      cwd: "C:\\smoke\\work",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    });
  });
});
