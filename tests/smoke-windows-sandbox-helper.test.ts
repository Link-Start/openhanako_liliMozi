import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  smokeWindowsSandboxHelper,
  windowsSandboxHelperPath,
} from "../scripts/smoke-windows-sandbox-helper.mjs";
import { standaloneRestrictedTokenSmokeSpec } from "../scripts/verify-standalone-server-artifact.mjs";

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

  it("runs PowerShell as a child of restricted cmd.exe on the private desktop", () => {
    const spec = standaloneRestrictedTokenSmokeSpec({
      layoutRoot: "C:\\HanaCore",
      workDir: "C:\\smoke\\work",
      hanaHome: "C:\\smoke\\home",
      helperPath: "C:\\HanaCore\\sandbox\\windows\\hana-win-sandbox.exe",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spec.env.HANA_WIN32_SANDBOX_DEBUG).toBe("1");
    expect(spec.powerShellArgs).not.toContain("--current-desktop");
    expect(spec.powerShellArgs).toContain("--verbatim-last-arg");
    expect(spec.powerShellArgs).toContain("C:\\Windows\\System32\\cmd.exe");
    expect(spec.powerShellArgs).toContain("/c");
    expect(spec.powerShellArgs.at(-1)).toContain(
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(spec.powerShellArgs.at(-1)).toContain("-EncodedCommand");
    expect(spec.powerShellArgs.at(-1)).not.toContain("HANA_RESTRICTED_POWERSHELL_OK");
  });
});
