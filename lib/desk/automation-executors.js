export function getAutomationExecutor(job) {
  if (job?.executor?.kind) return job.executor;
  return {
    kind: "agent_session",
    agentId: job?.actorAgentId || job?.legacyRef?.agentId || null,
    prompt: job?.prompt || "",
    model: job?.model,
    executionContext: job?.executionContext || null,
  };
}

export async function executeDirectAutomationAction(job, deps = {}) {
  const executor = getAutomationExecutor(job);
  if (executor.kind !== "direct_action") {
    throw new Error(`unsupported direct automation executor: ${executor.kind}`);
  }
  if (executor.action === "notify") {
    return executeNotifyAction(job, executor, deps);
  }
  throw new Error(`unsupported direct automation action: ${executor.action}`);
}

export async function executePluginAutomationAction(job, deps = {}) {
  const executor = getAutomationExecutor(job);
  if (executor.kind !== "plugin_action") {
    throw new Error(`unsupported plugin automation executor: ${executor.kind}`);
  }
  if (typeof deps.invokePluginAction !== "function") {
    throw new Error("plugin action gateway unavailable");
  }
  const pluginId = normalizeRequiredString(executor.pluginId, "plugin_action.pluginId");
  const actionId = normalizeRequiredString(executor.actionId, "plugin_action.actionId");
  const params = executor.params && typeof executor.params === "object" && !Array.isArray(executor.params)
    ? executor.params
    : {};
  const result = await deps.invokePluginAction(
    { pluginId, actionId, params },
    pluginActionRuntimeContext(job, executor),
  );
  return {
    executorKind: "plugin_action",
    pluginId,
    actionId,
    result,
  };
}

async function executeNotifyAction(job, executor, { deliverNotification } = {}) {
  if (typeof deliverNotification !== "function") {
    throw new Error("notification gateway unavailable");
  }
  const params = executor.params && typeof executor.params === "object" && !Array.isArray(executor.params)
    ? executor.params
    : {};
  const payload = {
    title: typeof params.title === "string" ? params.title : "",
    body: typeof params.body === "string" ? params.body : "",
    ...(Array.isArray(params.channels) ? { channels: params.channels } : {}),
    ...(Array.isArray(params.bridgePlatforms) ? { bridgePlatforms: params.bridgePlatforms } : {}),
    ...(typeof params.contextPolicy === "string" ? { contextPolicy: params.contextPolicy } : {}),
    ...(typeof params.audience === "string" ? { audience: params.audience } : {}),
  };
  const agentId = executor.agentId || job.actorAgentId || job.legacyRef?.agentId || null;
  const delivery = await deliverNotification(payload, { agentId });
  return {
    executorKind: "direct_action",
    action: "notify",
    delivery,
  };
}

function normalizeRequiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function pluginActionRuntimeContext(job, executor) {
  const executionContext = executor.executionContext || job.executionContext || null;
  return {
    jobId: job.id || null,
    label: job.label || "",
    actorAgentId: executor.agentId || job.actorAgentId || job.legacyRef?.agentId || null,
    executionContext,
    cwd: typeof executionContext?.cwd === "string" ? executionContext.cwd : null,
    workspaceFolders: Array.isArray(executionContext?.workspaceFolders)
      ? executionContext.workspaceFolders
      : [],
    sessionPath: typeof executionContext?.sourceSessionPath === "string"
      ? executionContext.sourceSessionPath
      : null,
  };
}
