import path from "node:path";
import { t } from "../../../lib/i18n.ts";

export function createTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function errorMessage(err) {
  return err?.message || String(err || t("plugin.imageGen.unknownError"));
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSessionPath(ctx) {
  const sessionPath = typeof ctx?.sessionPath === "string" ? ctx.sessionPath.trim() : "";
  return sessionPath || null;
}

export function generatedDirForCtx(ctx) {
  return path.join(ctx.dataDir, "generated");
}

export function createSubmitContext(ctx) {
  return {
    dataDir: ctx.dataDir,
    bus: ctx.bus,
    log: ctx.log,
    generatedDir: generatedDirForCtx(ctx),
    config: ctx.config,
  };
}

export function bridgeDeliveryTarget(ctx) {
  const bridge = ctx?.bridgeContext;
  if (bridge?.isBridgeSession !== true || !bridge.platform || !bridge.chatId) return null;
  return {
    kind: "bridge",
    platform: bridge.platform,
    chatId: bridge.chatId,
    ...(bridge.sessionKey ? { sessionKey: bridge.sessionKey } : {}),
    ...(bridge.agentId ? { agentId: bridge.agentId } : {}),
    ...(bridge.chatType ? { chatType: bridge.chatType } : {}),
  };
}

export function buildImageParams(input) {
  return {
    type: "image",
    prompt: input.prompt,
    ...(input.suggestedFilename && { filename: input.suggestedFilename }),
    ...(input.filename && { filename: input.filename }),
    ...(input.ratio && { ratio: input.ratio }),
    ...(input.resolution && { resolution: input.resolution }),
    ...(input.quality && { quality: input.quality }),
    ...(input.model && { model: input.model }),
    ...(input.image && { image: input.image }),
  };
}

export function imageDeferredMeta({ prompt, deliveryTarget = null }: any = {}) {
  return {
    type: "image-generation",
    mediaKind: "image",
    deliveryIntent: "ui_only",
    triggerParentTurn: false,
    notifyAgentOnFailure: true,
    prompt,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  };
}

async function adapterIsAvailable(adapter, submitCtx) {
  if (typeof adapter?.checkAuth !== "function") return true;
  try {
    const result = await adapter.checkAuth(submitCtx);
    return result?.ok !== false;
  } catch {
    return false;
  }
}

function targetFromAdapter(adapter, input, media: any = {}) {
  if (!adapter) return null;
  return {
    adapter,
    providerId: media.providerId || input.provider || adapter.id,
    modelId: media.modelId || input.model || null,
    protocolId: media.protocolId || adapter.protocolId || null,
    credentialLaneId: media.credentialLaneId || null,
    credentialProviderId: media.credentialProviderId || media.providerId || input.provider || adapter.id,
  };
}

async function listMediaProviders(submitCtx) {
  try {
    const result = await submitCtx.bus?.request?.("provider:media-providers", { capability: "image_generation" });
    return result?.providers && typeof result.providers === "object" ? result.providers : {};
  } catch {
    return {};
  }
}

async function resolveMediaModel(submitCtx, ref) {
  try {
    const result = await submitCtx.bus?.request?.("provider:resolve-media-model", {
      providerId: ref.providerId,
      modelId: ref.modelId,
      capability: "image_generation",
      ...(ref.credentialLaneId ? { credentialLaneId: ref.credentialLaneId } : {}),
    });
    if (result?.error) return { error: result.error };
    if (!result?.protocolId) return { error: `media model "${ref.providerId}/${ref.modelId}" missing protocolId` };
    return { media: result };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function explicitProviderError(providerId, detail = "") {
  return detail
    ? t("plugin.imageGen.providerUnavailableDetail", { providerId, detail })
    : t("plugin.imageGen.providerUnavailable", { providerId });
}

function explicitModelError(modelId, detail = "") {
  return detail
    ? t("plugin.imageGen.modelUnavailableDetail", { modelId, detail })
    : t("plugin.imageGen.modelUnavailable", { modelId });
}

async function availableAdapterOrThrow(adapter, submitCtx, providerId) {
  if (!adapter) throw new Error(explicitProviderError(providerId));
  if (typeof adapter.checkAuth === "function") {
    try {
      const auth = await adapter.checkAuth(submitCtx);
      if (auth?.ok === false) {
        throw new Error(auth.message || "credentials unavailable");
      }
    } catch (err) {
      throw new Error(explicitProviderError(providerId, errorMessage(err)));
    }
  }
  return adapter;
}

async function targetFromMediaRef(input, registry, submitCtx, ref, { strict = false } = {}) {
  if (!ref?.providerId) return null;
  let modelId = ref.modelId || null;
  if (!modelId) {
    const providers = await listMediaProviders(submitCtx);
    modelId = providers[ref.providerId]?.models?.[0]?.id || null;
    if (!modelId) {
      if (strict && providers[ref.providerId]) {
        throw new Error(explicitProviderError(ref.providerId, t("plugin.imageGen.noConfiguredModel")));
      }
      return null;
    }
  }

  const { media, error } = await resolveMediaModel(submitCtx, { providerId: ref.providerId, modelId });
  if (!media) {
    if (strict) throw new Error(explicitProviderError(ref.providerId, error || t("plugin.imageGen.modelNotFound", { modelId })));
    return null;
  }
  const adapter = registry.getProtocol?.(media.protocolId) || registry.get(media.providerId);
  if (!adapter) {
    if (strict) throw new Error(explicitProviderError(ref.providerId, t("plugin.imageGen.noRegisteredProtocol", { protocolId: media.protocolId })));
    return null;
  }
  return targetFromAdapter(adapter, input, media);
}

export async function validateImageModelRef(ref, registry, submitCtx) {
  const target = await targetFromMediaRef({}, registry, submitCtx, {
    providerId: ref?.providerId || ref?.provider,
    modelId: ref?.modelId || ref?.id || ref?.model,
    credentialLaneId: ref?.credentialLaneId,
  }, { strict: true });
  return {
    providerId: target.providerId,
    modelId: target.modelId,
    protocolId: target.protocolId,
    adapterId: target.adapter?.id || null,
    credentialLaneId: target.credentialLaneId || null,
    credentialProviderId: target.credentialProviderId || null,
  };
}

async function targetFromExplicitProvider(input, registry, submitCtx) {
  const mediaTarget = await targetFromMediaRef(input, registry, submitCtx, {
    providerId: input.provider,
    modelId: input.model || null,
  }, { strict: !!input.model });
  if (mediaTarget) return mediaTarget;

  const adapter = await availableAdapterOrThrow(registry.get(input.provider), submitCtx, input.provider);
  return targetFromAdapter(adapter, input, {
    providerId: input.provider,
    modelId: input.model || null,
    credentialProviderId: input.provider,
  });
}

async function targetFromExplicitModel(input, registry, submitCtx) {
  if (!input.model) return null;
  const providers = await listMediaProviders(submitCtx);
  const matches = [];
  for (const provider of Object.values(providers) as any[]) {
    const model = provider?.models?.find((item) => item?.id === input.model);
    if (model) matches.push({ providerId: provider.providerId, modelId: model.id });
  }
  if (matches.length === 1) {
    return targetFromMediaRef(input, registry, submitCtx, matches[0], { strict: true });
  }
  if (matches.length > 1) {
    throw new Error(explicitModelError(input.model, t("plugin.imageGen.multipleProvidersSameModel")));
  }
  throw new Error(explicitModelError(input.model, t("plugin.imageGen.modelNotInMediaProvider")));
}

async function targetFromConfiguredDefault(input, registry, submitCtx) {
  const defaultModel = submitCtx.config?.get?.("defaultImageModel");
  if (!defaultModel?.provider) return null;
  return targetFromMediaRef(input, registry, submitCtx, {
    providerId: defaultModel.provider,
    modelId: defaultModel.id,
  }, { strict: true });
}

async function targetFromFirstAvailableProvider(input, registry, submitCtx) {
  const providers = await listMediaProviders(submitCtx);
  for (const provider of Object.values(providers) as any[]) {
    if (provider?.hasCredentials === false) continue;
    const model = provider?.models?.find((item) => registry.getProtocol?.(item.protocolId));
    if (!model) continue;
    const target = await targetFromMediaRef(input, registry, submitCtx, {
      providerId: provider.providerId,
      modelId: model.id,
    });
    if (target) return target;
  }
  return null;
}

async function legacyAdapterTarget(input, registry, submitCtx) {
  if (input.provider) return targetFromAdapter(registry.get(input.provider), input);

  const defaultProvider = submitCtx.config?.get?.("defaultImageModel")?.provider;
  if (defaultProvider) {
    const adapter = registry.get(defaultProvider);
    if (adapter && await adapterIsAvailable(adapter, submitCtx)) return targetFromAdapter(adapter, input);
  }

  const adapters = registry.getByType("image");
  for (let i = adapters.length - 1; i >= 0; i--) {
    const adapter = adapters[i];
    if (await adapterIsAvailable(adapter, submitCtx)) return targetFromAdapter(adapter, input);
  }
  return targetFromAdapter(adapters.at(-1), input);
}

export async function resolveImageTarget(input, registry, submitCtx) {
  if (input.provider) {
    return targetFromExplicitProvider(input, registry, submitCtx);
  }

  if (input.model) {
    return targetFromExplicitModel(input, registry, submitCtx);
  }

  const configured = await targetFromConfiguredDefault(input, registry, submitCtx);
  if (configured) return configured;

  const available = await targetFromFirstAvailableProvider(input, registry, submitCtx);
  if (available) return available;

  return legacyAdapterTarget(input, registry, submitCtx);
}

export async function resolveImageAdapter(input, registry, submitCtx) {
  return (await resolveImageTarget(input, registry, submitCtx))?.adapter || null;
}

export function markSubmitFailed({ taskId, err, store, ctx }) {
  const message = errorMessage(err);
  store.update(taskId, {
    status: "failed",
    failReason: message,
    submitState: "failed",
    completedAt: new Date().toISOString(),
  });
  ctx.bus.request("deferred:fail", { taskId, error: err }).catch(() => {});
  ctx.bus.request("task:remove", { taskId }).catch(() => {});
  ctx.log?.error?.(`[image-gen] submit failed for ${taskId}:`, message);
}

export async function runSubmitInBackground({ taskId, adapter, params, submitCtx, store, poller, ctx }) {
  try {
    const result = await adapter.submit(params, submitCtx);
    const hasProviderTaskId = typeof result?.taskId === "string" && result.taskId.trim();
    const adapterTaskId = hasProviderTaskId ? result.taskId : taskId;
    const files = Array.isArray(result?.files) ? result.files.filter(Boolean) : [];

    if (!hasProviderTaskId && files.length === 0) {
      throw new Error(t("plugin.imageGen.noTaskIdOrFile"));
    }

    store.update(taskId, {
      submitState: "submitted",
      adapterTaskId,
      ...(files.length ? { files } : {}),
    });

    if (files.length && typeof poller.checkNow === "function") {
      void poller.checkNow(taskId);
    }
  } catch (err) {
    markSubmitFailed({ taskId, err, store, ctx });
  }
}

function retryError(status, error) {
  return { ok: false, status, error };
}

function isRetryableTaskStatus(status) {
  return status === "failed" || status === "cancelled" || status === "aborted";
}

function normalizeRetryParams(task) {
  if (isObject(task.params) && typeof task.params.prompt === "string" && task.params.prompt.trim()) {
    return { ...task.params, type: "image" };
  }
  if (typeof task.prompt === "string" && task.prompt.trim()) {
    return { type: "image", prompt: task.prompt };
  }
  return null;
}

export async function retryImageTask({ taskId, ctx }) {
  const { registry, store, poller } = ctx?._mediaGen || {};
  if (!registry || !store || !poller) {
    return retryError(503, t("plugin.imageGen.notInitialized"));
  }

  const task = store.get(taskId);
  if (!task) return retryError(404, "task not found");
  if (task.type !== "image") return retryError(400, "only image tasks can be retried here");
  if (task.status === "pending") return retryError(409, "task is already running");
  if (!isRetryableTaskStatus(task.status)) return retryError(409, "task is not retryable");

  const sessionPath = typeof task.sessionPath === "string" && task.sessionPath.trim()
    ? task.sessionPath
    : null;
  if (!sessionPath) return retryError(409, "task has no sessionPath");

  const adapter = registry.get(task.adapterId);
  if (!adapter || typeof adapter.submit !== "function") {
    return retryError(409, `adapter "${task.adapterId}" is unavailable`);
  }

  const params = normalizeRetryParams(task);
  if (!params) return retryError(409, "task has no reusable prompt");

  const prompt = typeof task.prompt === "string" && task.prompt.trim()
    ? task.prompt
    : params.prompt;
  const deliveryTarget = task.deliveryTarget || null;
  const meta = imageDeferredMeta({ prompt, deliveryTarget });

  await ctx.bus.request("deferred:retry", { taskId, sessionPath, meta });

  const now = new Date().toISOString();
  store.update(taskId, {
    status: "pending",
    failReason: null,
    submitState: "submitting",
    adapterTaskId: null,
    files: [],
    sessionFiles: [],
    imageWidth: null,
    imageHeight: null,
    completedAt: null,
    createdAt: now,
    retriedAt: now,
    retryCount: Number(task.retryCount || 0) + 1,
  });

  try {
    await ctx.bus.request("task:register", {
      taskId,
      type: "media-generation",
      parentSessionPath: sessionPath,
      meta,
    });
  } catch {
    // TaskRegistry is runtime visibility only; DeferredResultStore owns delivery.
  }

  poller.add(taskId);

  const submitCtx = createSubmitContext(ctx);
  void runSubmitInBackground({
    taskId,
    adapter,
    params,
    submitCtx,
    store,
    poller,
    ctx,
  });

  return {
    ok: true,
    taskId,
    placeholder: {
      type: "media_generation",
      taskId,
      kind: "image",
      ...(task.batchId ? { batchId: task.batchId } : {}),
      prompt,
      status: "pending",
    },
  };
}
