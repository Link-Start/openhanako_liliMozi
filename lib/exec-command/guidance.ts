import { WIN32_DEFAULT_ONE_SHOT_SHELL } from "./shell.ts";

export function execCommandDescription({ platform = process.platform }: { platform?: NodeJS.Platform } = {}) {
  const common = [
    "Run a short, one-shot local command in the current session.",
    "When the OS sandbox is enabled, one-shot commands use its network-blocked path by default on macOS/Linux. Set sandbox_permissions=\"require_escalated\" only when the command genuinely needs reviewed network-capable execution; explicit sandbox network settings still apply.",
    "In Auto mode, network-blocked one-shot commands run as routine work under the session permission mode; interactive, unsandboxed, and escalated commands remain reviewable. The OS sandbox restricts files and networking but does not isolate every host IPC surface; use Ask mode when each command needs explicit confirmation.",
    "Use tty=true only when the command must remain interactive or long-running; then continue with write_stdin.",
    "For local GUI app control, use the computer tool instead of shell commands.",
  ];
  if (platform === "win32") {
    common.push(
      "Windows cannot isolate command networking; sandbox_permissions=\"use_default\" still uses the restricted-token runner but requires the same permission review.",
      `On Windows the default one-shot shell is ${WIN32_DEFAULT_ONE_SHOT_SHELL.display}. Use ${WIN32_DEFAULT_ONE_SHOT_SHELL.display} syntax for builtins, chaining, pipelines, and redirection.`,
      "PowerShell cannot start reliably inside the Windows restricted-token sandbox. Use shell=\"powershell\" only with sandbox_permissions=\"require_escalated\".",
      "Use shell=\"bash\" only for explicit POSIX commands; the bundled runtime provides an sh-compatible shell (POSIX sh syntax, not full Bash). Bash-specific features require a system Git Bash install.",
      "Avoid POSIX heredocs on Windows; use python -c or a temporary file instead.",
    );
  } else {
    common.push("On macOS/Linux the default shell is the existing POSIX shell runner.");
  }
  return common.join(" ");
}

export function writeStdinDescription() {
  return [
    "Write input to a running exec_command process started with tty=true.",
    "Pass the process_id returned by exec_command and the exact characters to send, including newlines when needed.",
  ].join(" ");
}
