import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WIN32_DEFAULT_ONE_SHOT_SHELL, renderCommandWithWorkdir, resolveExecShell } from "../lib/exec-command/shell.ts";
import { execCommandDescription } from "../lib/exec-command/guidance.ts";
import { createExecCommandTools } from "../lib/exec-command/tool.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

const DEFAULT_TEST_CWD = "/tmp/work";

function makeCtx(sessionPath = "/tmp/session.jsonl", cwd = DEFAULT_TEST_CWD) {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
      getCwd: () => cwd,
    },
  };
}

function resolvedTestCwd(cwd = DEFAULT_TEST_CWD) {
  return path.resolve(cwd);
}

function expectedRenderedCommand(command: string, platform: NodeJS.Platform, cwd = DEFAULT_TEST_CWD) {
  return renderCommandWithWorkdir(command, resolveExecShell({ platform }), {
    workdir: resolvedTestCwd(cwd),
    defaultCwd: cwd,
    platform,
  });
}

describe("exec_command tools", () => {
  it("declares contained one-shot commands routine and boundary-crossing commands reviewable", () => {
    const [contained] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      isOneShotSandboxEnforced: () => true,
      platform: "linux",
    });
    const [uncontained] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      isOneShotSandboxEnforced: () => false,
      platform: "linux",
    });

    expect(contained.sessionPermission.resolveInvocation({ cmd: "pwd" })).toMatchObject({
      kind: "routine",
      sideEffect: {
        sandboxed: true,
        sandboxPermissions: "use_default",
        networkAccess: "blocked",
        hostIpcAccess: "available",
      },
    });
    expect(contained.sessionPermission.resolveInvocation({
      cmd: "npm view vitest version",
      sandbox_permissions: "require_escalated",
    })).toMatchObject({ kind: "review" });
    expect(contained.sessionPermission.resolveInvocation({ cmd: "npm run dev", tty: true }))
      .toMatchObject({ kind: "review" });
    expect(uncontained.sessionPermission.resolveInvocation({ cmd: "pwd" }))
      .toMatchObject({ kind: "review" });
  });

  it("routes one-shot commands through the wrapped bash tool and returns nonzero exits as structured output", async () => {
    const platform = "win32";
    const bashTool = {
      execute: vi.fn(async () => {
        throw new Error("Command exited with code 127\npython: not found");
      }),
    };
    const [execCommand] = createExecCommandTools({
      bashTool,
      getCwd: () => DEFAULT_TEST_CWD,
      platform,
    });

    const result: any = await execCommand.execute("call-1", {
      cmd: "python --version",
      max_output_tokens: 1000,
    }, null, null, makeCtx());

    expect(bashTool.execute).toHaveBeenCalledWith(
      "call-1",
      { command: expectedRenderedCommand("python --version", platform) },
      null,
      null,
      expect.any(Object),
    );
    expect(result.content[0].text).toContain("python: not found");
    expect(result.isError).toBe(true);
    expect(result.details.execCommand).toMatchObject({
      ok: false,
      exitCode: 127,
      errorCode: "EXEC_COMMAND_DEPENDENCY_MISSING",
      shell: "powershell",
      classification: { kind: "probe" },
    });
  });

  it("routes Windows one-shot commands through commandExec and decodes GBK output without PI bash", async () => {
    const platform = "win32";
    const gbkCopyText = Buffer.from([0xb8, 0xb4, 0xd6, 0xc6]);
    const bashTool = { execute: vi.fn() };
    const commandExec = vi.fn(async (_command, _cwd, opts = {}) => {
      opts.onData(gbkCopyText);
      return { exitCode: 1 };
    });
    const [execCommand] = createExecCommandTools({
      bashTool,
      commandExec,
      getCwd: () => DEFAULT_TEST_CWD,
      platform,
    });

    const result: any = await execCommand.execute("call-gbk", {
      cmd: "copy C:\\missing.txt C:\\target\\",
      max_output_tokens: 1000,
    }, null, null, makeCtx());

    expect(bashTool.execute).not.toHaveBeenCalled();
    expect(commandExec).toHaveBeenCalledWith(
      expectedRenderedCommand("copy C:\\missing.txt C:\\target\\", platform),
      resolvedTestCwd(),
      expect.objectContaining({
        timeout: undefined,
        signal: null,
        onData: expect.any(Function),
      }),
    );
    expect(result.content[0].text).toContain("复制");
    expect(result.content[0].text).not.toContain("�");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      outputEncoding: "gbk",
      outputTranscoded: true,
      execCommand: {
        ok: false,
        exitCode: 1,
        errorCode: "EXEC_COMMAND_EXIT_NONZERO",
        shell: "powershell",
      },
    });
  });

  it("routes use_default and require_escalated through separate one-shot runners", async () => {
    const defaultBashTool = {
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "default" }] })),
    };
    const escalatedBashTool = {
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "escalated" }] })),
    };
    const [execCommand] = createExecCommandTools({
      bashTool: defaultBashTool,
      escalatedBashTool,
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "linux",
    });

    const defaultResult: any = await execCommand.execute(
      "call-default",
      { cmd: "pwd" },
      null,
      null,
      makeCtx(),
    );
    const escalatedResult: any = await execCommand.execute(
      "call-escalated",
      {
        cmd: "npm view vitest version",
        sandbox_permissions: "require_escalated",
        justification: "Check the latest published vitest version?",
      },
      null,
      null,
      makeCtx(),
    );

    expect(defaultBashTool.execute).toHaveBeenCalledOnce();
    expect(escalatedBashTool.execute).toHaveBeenCalledOnce();
    expect(defaultResult.content[0].text).toBe("default");
    expect(defaultResult.details.execCommand.sandboxPermissions).toBe("use_default");
    expect(escalatedResult.content[0].text).toBe("escalated");
    expect(escalatedResult.details.execCommand.sandboxPermissions).toBe("require_escalated");
  });

  it("rejects unknown sandbox_permissions before invoking a command runner", async () => {
    const bashTool = { execute: vi.fn() };
    const [execCommand] = createExecCommandTools({
      bashTool,
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "linux",
    });

    const result: any = await execCommand.execute(
      "call-invalid-sandbox-permissions",
      { cmd: "pwd", sandbox_permissions: "network_on" },
      null,
      null,
      makeCtx(),
    );

    expect(bashTool.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details.errorCode).toBe("EXEC_COMMAND_INVALID_SANDBOX_PERMISSIONS");
  });

  it("starts tty processes through the terminal manager and write_stdin writes to the same process id", async () => {
    const platform = "linux";
    const manager = {
      start: vi.fn(async (input) => ({ ...input, terminalId: "term_1", status: "running", seq: 0, output: "" })),
      write: vi.fn((input) => ({ ...input, status: "running", seq: 1 })),
    };
    const [execCommand, writeStdin] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getTerminalSessionManager: () => manager,
      getAgentId: () => "hana",
      getCwd: () => DEFAULT_TEST_CWD,
      platform,
    });
    const ctx = makeCtx("/tmp/session.jsonl", DEFAULT_TEST_CWD);

    const started: any = await execCommand.execute("call-tty", {
      cmd: "npm run dev",
      tty: true,
    }, null, null, ctx);
    const parsedStart = JSON.parse(started.content[0].text);

    expect(parsedStart.process_id).toBe("term_1");
    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/session.jsonl",
      agentId: "hana",
      cwd: resolvedTestCwd(),
      command: expectedRenderedCommand("npm run dev", platform),
    }));

    const written: any = await writeStdin.execute("call-stdin", {
      process_id: parsedStart.process_id,
      chars: "q\n",
    }, null, null, ctx);
    const parsedWrite = JSON.parse(written.content[0].text);

    expect(parsedWrite).toMatchObject({
      sessionPath: "/tmp/session.jsonl",
      terminalId: "term_1",
      chars: "q\n",
    });
  });

  it("returns a targeted Windows syntax error instead of invoking the runner for POSIX heredocs", async () => {
    const bashTool = { execute: vi.fn() };
    const [execCommand] = createExecCommandTools({
      bashTool,
      getCwd: () => "C:\\work",
      platform: "win32",
    });

    const result: any = await execCommand.execute("call-heredoc", {
      cmd: "python - <<'PY'\nprint('x')\nPY",
    }, null, null, makeCtx("C:\\session.jsonl", "C:\\work"));

    expect(bashTool.execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      errorCode: "EXEC_COMMAND_POSIX_SYNTAX_ON_WINDOWS",
      execCommand: { ok: false },
    });
  });

  it("resolves invocation for multiline cmd strings", () => {
    const [execCommandTool] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      isOneShotSandboxEnforced: () => true,
      platform: "linux",
    });

    const invocation = execCommandTool.sessionPermission.resolveInvocation({
      cmd: "python -c \"import sys\nprint(sys.version)\"",
    });

    expect(invocation).not.toBeNull();
    expect(resolveToolInvocationPermission(execCommandTool, {
      cmd: "python -c \"import sys\nprint(sys.version)\"",
    })).toMatchObject({ ok: true, source: "descriptor" });
  });

  it("rejects require_escalated without a justification", async () => {
    const bashTool = { execute: vi.fn() };
    const [execCommand] = createExecCommandTools({
      bashTool,
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "win32",
    });

    const result: any = await execCommand.execute("t1", {
      cmd: "wmic path Win32_VideoController get Name",
      sandbox_permissions: "require_escalated",
    }, undefined, undefined, makeCtx());

    expect(bashTool.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("justification");
  });

  it("threads justification into the invocation sideEffect", () => {
    const [execCommandTool] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "win32",
    });

    const invocation: any = execCommandTool.sessionPermission.resolveInvocation({
      cmd: "pnputil /enum-devices",
      sandbox_permissions: "require_escalated",
      justification: "Read display device inventory to debug color management?",
    });

    expect(invocation.sideEffect.justification).toContain("display device inventory");
  });

  it("truncates an overlong justification to 300 characters in the invocation sideEffect", () => {
    const [execCommandTool] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "win32",
    });

    const overlong = "x".repeat(400);
    const invocation: any = execCommandTool.sessionPermission.resolveInvocation({
      cmd: "pnputil /enum-devices",
      sandbox_permissions: "require_escalated",
      justification: overlong,
    });

    expect(invocation.sideEffect.justification).toHaveLength(300);
  });

  it("describes the same default shell that resolveExecShell actually uses on win32", () => {
    const [execCommandTool] = createExecCommandTools({
      bashTool: { execute: vi.fn() },
      getCwd: () => DEFAULT_TEST_CWD,
      platform: "win32",
    });

    const resolved = resolveExecShell({ platform: "win32" });
    const description = execCommandDescription({ platform: "win32" });
    const cmdParamDescription = (execCommandTool.parameters.properties as any).cmd.description;

    expect(description).toContain(`default one-shot shell is ${WIN32_DEFAULT_ONE_SHOT_SHELL.display}`);
    // Parameter description must be platform-neutral: no per-platform shell claim here,
    // otherwise it becomes a second source of truth alongside the tool description.
    expect(cmdParamDescription).not.toMatch(/PowerShell|cmd\.exe/);
    expect(resolved.family).toBe(WIN32_DEFAULT_ONE_SHOT_SHELL.family);
  });

  it("guides the model to retry sandbox-blocked commands with require_escalated and a justification", () => {
    const description = execCommandDescription({ platform: "win32" });

    expect(description).toContain(
      "rerun it with sandbox_permissions=\"require_escalated\" and a one-sentence justification",
    );
    expect(description).not.toContain(
      "only when the command genuinely needs reviewed network-capable execution",
    );
  });
});
