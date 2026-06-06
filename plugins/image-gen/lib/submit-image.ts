import {
  bridgeDeliveryTarget,
  buildImageParams,
  createSubmitContext,
  createTaskId,
  imageDeferredMeta,
  normalizeSessionPath,
  resolveImageTarget,
  runSubmitInBackground,
} from "./image-task-runner.ts";
import { t } from "../../../lib/i18n.ts";

function assertMediaRuntime(ctx) {
  const { registry, store, poller } = ctx?._mediaGen || {};
  if (!registry || !store || !poller) {
    throw new Error(t("plugin.imageGen.notInitialized"));
  }
  return { registry, store, poller };
}

export async function submitImageGeneration({ input = {}, ctx, metadata = null, deliveryTarget = undefined }: any = {}) {
  const { registry, store, poller } = assertMediaRuntime(ctx);
  const sessionPath = normalizeSessionPath(ctx);
  if (!sessionPath) {
    throw new Error(t("plugin.imageGen.noSessionPath"));
  }

  const submitCtx = createSubmitContext(ctx);
  const target = await resolveImageTarget(input, registry, submitCtx);
  const adapter = target?.adapter || null;
  if (!adapter) throw new Error(t("plugin.imageGen.noProvider"));

  const count = Math.min(Math.max(input.count || 1, 1), 9);
  const batchId = createTaskId();
  const params = {
    ...buildImageParams(input),
    providerId: target.providerId,
    ...(target.modelId ? { modelId: target.modelId, model: target.modelId } : {}),
    ...(target.protocolId ? { protocolId: target.protocolId } : {}),
    ...(target.credentialLaneId ? { credentialLaneId: target.credentialLaneId } : {}),
    ...(target.credentialProviderId ? { credentialProviderId: target.credentialProviderId } : {}),
  };

  const resolvedDeliveryTarget = deliveryTarget === undefined ? bridgeDeliveryTarget(ctx) : deliveryTarget;
  const deferredMeta = {
    ...imageDeferredMeta({ prompt: input.prompt, deliveryTarget: resolvedDeliveryTarget }),
    ...(metadata ? { metadata } : {}),
  };

  const submitted = [];
  for (let i = 0; i < count; i++) {
    const taskId = createTaskId();
    store.add({
      taskId,
      adapterId: adapter.id,
      providerId: target.providerId,
      modelId: target.modelId,
      protocolId: target.protocolId,
      credentialLaneId: target.credentialLaneId,
      batchId,
      type: "image",
      prompt: input.prompt,
      params,
      sessionPath,
      ...(resolvedDeliveryTarget ? { deliveryTarget: resolvedDeliveryTarget } : {}),
      ...(metadata ? { metadata } : {}),
      submitState: "submitting",
      adapterTaskId: null,
    });

    try {
      await ctx.bus.request("deferred:register", {
        taskId,
        sessionPath,
        meta: deferredMeta,
      });
    } catch (err) {
      ctx.log?.warn?.(`deferred:register failed for ${taskId}:`, err);
    }

    try {
      await ctx.bus.request("task:register", {
        taskId,
        type: "media-generation",
        parentSessionPath: sessionPath,
        meta: deferredMeta,
      });
    } catch {
      // TaskRegistry is best-effort visibility; generation delivery still uses deferred results.
    }

    poller.add(taskId);
    submitted.push({ taskId });

    void runSubmitInBackground({
      taskId,
      adapter,
      params,
      submitCtx,
      store,
      poller,
      ctx,
    });
  }

  return {
    ok: true,
    kind: "image",
    batchId,
    prompt: input.prompt,
    tasks: submitted,
  };
}
