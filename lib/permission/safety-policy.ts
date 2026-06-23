const GIT_PUSH_RULES = {
  force: {
    id: "force-push-blocked",
    reason: "Force push is blocked by Hana safety policy.",
  },
  tags: {
    id: "push-tags-blocked",
    reason: "Bulk tag push is blocked by Hana safety policy. Push one explicit tag ref after release review.",
  },
  all: {
    id: "push-all-blocked",
    reason: "Pushing all branches is blocked by Hana safety policy.",
  },
  mirror: {
    id: "push-mirror-blocked",
    reason: "Mirror push is blocked by Hana safety policy.",
  },
};

function commandFromRequest(request: any = {}) {
  const command = request.params?.command || request.params?.cmd || request.target?.label;
  return typeof command === "string" ? command : "";
}

function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function executableBasename(token) {
  const normalized = String(token || "").replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function isGitExecutableToken(token) {
  const base = executableBasename(token);
  return base === "git" || base === "git.exe";
}

function nestedShellCommand(tokens, index) {
  const base = executableBasename(tokens[index]);
  const isPosixShell = base === "sh" || base === "sh.exe"
    || base === "bash" || base === "bash.exe"
    || base === "zsh" || base === "zsh.exe"
    || base === "fish" || base === "fish.exe";
  if (isPosixShell) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--") return null;
      if (token === "-c" || (/^-[^-]+$/.test(token) && token.includes("c"))) return tokens[i + 1] || null;
      if (!token.startsWith("-")) return null;
    }
    return null;
  }

  const isPowerShell = base === "powershell" || base === "powershell.exe"
    || base === "pwsh" || base === "pwsh.exe";
  if (isPowerShell) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = String(tokens[i] || "").toLowerCase();
      if (token === "-command" || token === "-c" || token === "/c") return tokens[i + 1] || null;
    }
    return null;
  }

  if (base === "cmd" || base === "cmd.exe") {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = String(tokens[i] || "").toLowerCase();
      if (token === "/c" || token === "-c") return tokens[i + 1] || null;
    }
  }
  return null;
}

function gitGlobalOptionConsumesValue(token) {
  if (token.includes("=")) return false;
  return token === "-C"
    || token === "-c"
    || token === "--git-dir"
    || token === "--work-tree"
    || token === "--namespace"
    || token === "--exec-path"
    || token === "--config-env"
    || token === "--super-prefix";
}

function detectGitPush(command, depth = 0) {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (depth < 3) {
      const nested = nestedShellCommand(tokens, i);
      if (nested) {
        const nestedGitPush = detectGitPush(nested, depth + 1);
        if (nestedGitPush) return nestedGitPush;
      }
    }
    if (!isGitExecutableToken(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j];
      if (token === "push") {
        const args = tokens.slice(j + 1);
        return {
          hasForce: args.some((arg) => arg === "-f"
            || arg === "--force"
            || arg.startsWith("--force-with-lease")
            || arg.startsWith("+")),
          hasTags: args.includes("--tags") || args.includes("--follow-tags"),
          hasAll: args.includes("--all"),
          hasMirror: args.includes("--mirror"),
        };
      }
      if (token === "--") break;
      if (token.startsWith("-")) {
        j += gitGlobalOptionConsumesValue(token) ? 2 : 1;
        continue;
      }
      break;
    }
  }
  return null;
}

export function evaluateToolSafetyPolicy(request: any = {}) {
  const command = commandFromRequest(request);
  if (!command) return null;
  const gitPush = detectGitPush(command);
  if (!gitPush) return null;
  const rule = gitPush.hasForce
    ? GIT_PUSH_RULES.force
    : gitPush.hasMirror
      ? GIT_PUSH_RULES.mirror
      : gitPush.hasAll
        ? GIT_PUSH_RULES.all
        : gitPush.hasTags
          ? GIT_PUSH_RULES.tags
          : null;
  if (!rule) return null;
  return {
    action: "block",
    code: "ACTION_BLOCKED_BY_SAFETY_POLICY",
    reviewer: "safety_policy",
    reason: rule.reason,
    risk: "critical",
    ruleIds: [rule.id],
  };
}
