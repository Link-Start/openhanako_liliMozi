import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnAndStream = vi.fn(async () => ({ exitCode: 0 }));
const classifyWin32Command = vi.fn();
const prepareSandboxRuntime = vi.fn((runtimeInfo) => runtimeInfo);
const existsSync = vi.fn(() => false);
const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("../lib/sandbox/win32-runtime-cache.js", () => ({
  prepareSandboxRuntime,
}));

vi.mock("fs", () => ({
  existsSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.js");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    prepareSandboxRuntime.mockImplementation((runtimeInfo) => runtimeInfo);
    existsSync.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", "ipconfig /all"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes simple Git commands through bundled git.exe without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    existsSync.mockImplementation((p) => p === gitExe);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec('git -C "C:\\Users\\Me\\repo" status --short "src file.txt"', "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      gitExe,
      ["-C", "C:\\Users\\Me\\repo", "status", "--short", "src file.txt"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Git commands through bundled git.exe via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      gitExe,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("rewrites sandboxed Git commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\git-cache";
    const cachedGit = `${cachedRoot}\\cmd\\git.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "git",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        git: cachedGit,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedGit,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(gitExe);
  });

  it("grants sandboxed Python commands read-write access to the Python runtime", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const pythonRoot = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === pythonExe || p === pythonRoot || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec("python tools\\make_doc.py", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311;C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        pythonExe,
        "tools\\make_doc.py",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("--grant-write-optional");
    expect(helperArgs).not.toContain(pythonRoot);
  });

  it("routes sandboxed simple Node commands through the current Node runtime via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const nodeRoot = "C:\\Hanako\\resources\\server";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === nodeRoot || p === helper);

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        nodeExe,
        "server.js",
        "--port",
        "3000",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(nodeRoot);
  });

  it("rewrites sandboxed Node commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\node-cache";
    const cachedNode = `${cachedRoot}\\hana-server.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "node",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        executable: cachedNode,
      };
    });

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedNode,
      "server.js",
      "--port",
      "3000",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\server");
    expect(helperArgs).not.toContain(nodeExe);
  });

  it("rejects explicit Python executables outside the workspace when they are not on PATH", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const privatePython = "D:\\Secrets\\python.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === privatePython || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python.exe") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await expect(exec('"D:\\Secrets\\python.exe" tools\\make_doc.py', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("outside the workspace");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers bundled POSIX runtime over system Git Bash when sandbox is disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === systemBash);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledShell,
      ["-lc", "ls && pwd"],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^C:\\Hanako\\resources\\git\\bin;C:\\Hanako\\resources\\git\\usr\\bin;C:\\Hanako\\resources\\git\\mingw64\\bin;C:\\Hanako\\resources\\git\\cmd;/),
        }),
      })
    );
  });

  it("rejects CMD nul redirection before executing bash-routed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(exec("ipconfig /all > nul 2>&1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("/dev/null");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("routes sandbox-enabled bash commands through the restricted-token helper with write roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: ["C:\\outside\\reference.md"],
          optionalReadPaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml"],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--cwd",
        "C:\\work",
        "--writable-root",
        "C:\\work",
        "--writable-root-optional",
        "C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory",
        "--",
        bundledShell,
        "-lc",
        "ls && pwd",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("C:\\outside\\reference.md");
    expect(helperArgs).not.toContain("C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml");
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
  });

  it("rewrites sandboxed Bash commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\bash-cache";
    const cachedShell = `${cachedRoot}\\bin\\bash.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "bash",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        shell: cachedShell,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedShell,
      "-lc",
      "ls && pwd",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(bundledShell);
  });

  it("does not pass network capability flags for restricted-token sandboxed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--",
      bundledShell,
      "-lc",
      "curl https://example.com",
    ]));
    expect(helperArgs).not.toContain("--network");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("keeps network unrestricted by default without helper network flags", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--network");
  });

  it("rejects sandboxed commands when Windows sandbox networking is explicitly disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => false,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("rejects sandboxed commands when Windows sandbox networking mode is none", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkMode: () => "none",
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("does not call obsolete external read path projection for restricted-token grants", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const getExternalReadPaths = vi.fn(() => ["C:\\outside\\secret.txt"]);
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        policy: {
          mode: "workspace-write",
          workspace: "C:\\work",
          workspaceRoots: ["C:\\work"],
          writablePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
        getExternalReadPaths,
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(getExternalReadPaths).not.toHaveBeenCalled();
    expect(helperArgs).not.toContain("C:\\outside\\secret.txt");
    expect(helperArgs).not.toContain("--grant-read");
  });

  it("does not fall back to system Git Bash for sandboxed POSIX commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === systemBash || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await expect(exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      })).rejects.toThrow("Sandboxed POSIX commands require bundled");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });
});
