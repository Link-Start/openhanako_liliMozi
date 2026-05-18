import { classifyWin32Command } from "../sandbox/win32-command-router.js";
import {
  getWin32ShellEnvForRuntime,
  resolveWin32ShellRuntime,
} from "../sandbox/win32-exec.js";

function envValue(env, name) {
  const source = env || {};
  const direct = source[name];
  if (direct) return direct;
  const key = Object.keys(source).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? source[key] : undefined;
}

function resolveCmd(env) {
  return envValue(env, "COMSPEC") || envValue(process.env, "COMSPEC") || "cmd.exe";
}

export function resolveTerminalShell(command = "", {
  platform = process.platform,
  env = process.env,
  classifyWin32Command: classify = classifyWin32Command,
  resolveWin32ShellRuntime: resolveWin32Shell = resolveWin32ShellRuntime,
  getWin32ShellEnvForRuntime: getWin32ShellEnv = getWin32ShellEnvForRuntime,
} = {}) {
  const input = typeof command === "string" ? command : "";

  if (platform === "win32") {
    const cmd = resolveCmd(env);
    if (!input) {
      return { file: cmd, args: [], env: undefined };
    }

    const route = classify(input);
    if (route?.runner === "cmd") {
      return { file: cmd, args: ["/d", "/s", "/c", input], env: undefined };
    }

    const shellInfo = resolveWin32Shell({
      preferBundled: true,
      env,
    });
    return {
      file: shellInfo.shell,
      args: [...shellInfo.args, input],
      env: getWin32ShellEnv(env, shellInfo),
    };
  }

  const shell = envValue(env, "SHELL") || envValue(process.env, "SHELL") || "/bin/bash";
  return input
    ? { file: shell, args: ["-lc", input], env: undefined }
    : { file: shell, args: ["-i"], env: undefined };
}
