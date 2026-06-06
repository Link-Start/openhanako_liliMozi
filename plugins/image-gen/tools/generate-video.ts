/**
 * plugins/image-gen/tools/generate-video.js
 *
 * Non-blocking video generation. Submits via adapter, returns card immediately.
 */
import path from "node:path";
import { t } from "../../../lib/i18n.ts";

export const name = "generate-video";
export const description = t("toolDef.generateVideo.description");

export const parameters = {
  type: "object",
  properties: {
    prompt:   { type: "string", description: t("toolDef.generateVideo.promptDesc") },
    image:    { type: "string", description: t("toolDef.generateVideo.imageDesc") },
    duration: { type: "number", description: t("toolDef.generateVideo.durationDesc") },
    ratio:    { type: "string", description: t("toolDef.generateVideo.ratioDesc") },
    model:    { type: "string", description: t("toolDef.generateVideo.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateVideo.providerDesc") },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return { content: [{ type: "text", text: t("toolDef.generateVideo.notInitialized") }] };
  }

  // Build adapter context
  const generatedDir = path.join(ctx.dataDir, "generated");
  const submitCtx = { dataDir: ctx.dataDir, bus: ctx.bus, log: ctx.log, generatedDir, config: ctx.config };

  // Resolve adapter: explicit → last registered (external adapters take over)
  const adapter = input.provider
    ? registry.get(input.provider)
    : registry.getByType("video").at(-1) || null;
  if (!adapter) {
    return { content: [{ type: "text", text: t("toolDef.generateVideo.noProvider") }] };
  }

  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const params = {
    type: "video",
    prompt: input.prompt,
    ...(input.image && { image: input.image }),
    ...(input.duration && { duration: input.duration }),
    ...(input.ratio && { ratio: input.ratio }),
    ...(input.model && { model: input.model }),
  };

  // Single submit (no concurrent video generation)
  let result;
  try {
    result = await adapter.submit(params, submitCtx);
  } catch (err) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailed", { error: err?.message || t("plugin.imageGen.unknownError") }) }],
    };
  }

  if (!result?.taskId) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailedUnknown") }],
    };
  }

  store.add({
    taskId: result.taskId,
    adapterId: adapter.id,
    batchId,
    type: "video",
    prompt: input.prompt,
    params,
    sessionPath: ctx.sessionPath,
  });

  // If submit returned files, update the task with them
  if (result.files?.length) {
    store.update(result.taskId, { files: result.files });
  }

  // Register deferred notification
  try {
    await ctx.bus.request("deferred:register", {
      taskId: result.taskId,
      sessionPath: ctx.sessionPath,
      meta: {
        type: "video-generation",
        mediaKind: "video",
        deliveryIntent: "ui_only",
        triggerParentTurn: false,
        prompt: input.prompt,
      },
    });
  } catch (err) {
    ctx.log.warn(`deferred:register failed for ${result.taskId}:`, err);
  }

  // Register in TaskRegistry for visibility and cancellation
  try {
    await ctx.bus.request("task:register", {
      taskId: result.taskId,
      type: "media-generation",
      parentSessionPath: ctx.sessionPath,
      meta: { type: "video-generation", prompt: input.prompt },
    });
  } catch {}

  // Add to poller (handles fake-async detection internally)
  poller.add(result.taskId);

  return {
    content: [{ type: "text", text: t("toolDef.generateVideo.submitted") }],
    details: {
      mediaGeneration: {
        kind: "video",
        batchId,
        prompt: input.prompt,
        tasks: [{ taskId: result.taskId }],
      },
    },
  };
}
