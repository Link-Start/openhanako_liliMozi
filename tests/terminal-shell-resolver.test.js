import { describe, expect, it, vi } from "vitest";

import { resolveTerminalShell } from "../lib/terminal/shell-resolver.js";

describe("resolveTerminalShell", () => {
  it("routes Windows one-shot terminal commands through POSIX shell to preserve quoted argv", () => {
    const shellInfo = {
      shell: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc"],
      bundledRoot: "C:\\Hanako\\resources\\git",
    };
    const shellEnv = { Path: "C:\\Hanako\\resources\\git\\bin;C:\\Windows\\System32" };
    const resolveWin32ShellRuntime = vi.fn(() => shellInfo);
    const getWin32ShellEnvForRuntime = vi.fn(() => shellEnv);

    const resolved = resolveTerminalShell("codex exec \"hello world from hanako\"", {
      platform: "win32",
      env: { Path: "C:\\Windows\\System32" },
      classifyWin32Command: () => ({ runner: "bash", reason: "default-bash" }),
      resolveWin32ShellRuntime,
      getWin32ShellEnvForRuntime,
    });

    expect(resolved).toEqual({
      file: shellInfo.shell,
      args: ["-lc", "codex exec \"hello world from hanako\""],
      env: shellEnv,
    });
    expect(resolveWin32ShellRuntime).toHaveBeenCalledWith({
      preferBundled: true,
      env: { Path: "C:\\Windows\\System32" },
    });
    expect(getWin32ShellEnvForRuntime).toHaveBeenCalledWith(
      { Path: "C:\\Windows\\System32" },
      shellInfo,
    );
  });

  it("keeps Windows interactive terminals on cmd.exe", () => {
    const resolveWin32ShellRuntime = vi.fn();

    const resolved = resolveTerminalShell("", {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      resolveWin32ShellRuntime,
    });

    expect(resolved).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
      env: undefined,
    });
    expect(resolveWin32ShellRuntime).not.toHaveBeenCalled();
  });

  it("keeps explicit Windows command one-shots on cmd.exe", () => {
    const resolveWin32ShellRuntime = vi.fn();

    const resolved = resolveTerminalShell("dir", {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      classifyWin32Command: () => ({ runner: "cmd", reason: "cmd-builtin" }),
      resolveWin32ShellRuntime,
    });

    expect(resolved).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
      env: undefined,
    });
    expect(resolveWin32ShellRuntime).not.toHaveBeenCalled();
  });

  it("keeps non-Windows behavior unchanged", () => {
    expect(resolveTerminalShell("npm run dev", {
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
    })).toEqual({
      file: "/bin/zsh",
      args: ["-lc", "npm run dev"],
      env: undefined,
    });

    expect(resolveTerminalShell("", {
      platform: "linux",
      env: { SHELL: "/bin/bash" },
    })).toEqual({
      file: "/bin/bash",
      args: ["-i"],
      env: undefined,
    });
  });
});
