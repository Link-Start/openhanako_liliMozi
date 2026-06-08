/**
 * plugins/image-gen/tools/generate-image.js
 *
 * Non-blocking image generation. Registers a local task immediately, then
 * submits to the provider in the background. Completion is delivered through
 * Poller + DeferredResultStore.
 */
import { submitImageGeneration } from "../lib/submit-image.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "generate-image";
export const description = t("toolDef.generateImage.description");

export const parameters = {
  type: "object",
  properties: {
    prompt:     { type: "string", description: t("toolDef.generateImage.promptDesc") },
    count:      { type: "number", description: t("toolDef.generateImage.countDesc") },
    image:      { type: "string", description: t("toolDef.generateImage.imageDesc") },
    ratio:      { type: "string", description: t("toolDef.generateImage.ratioDesc") },
    resolution: { type: "string", description: t("toolDef.generateImage.resolutionDesc") },
    quality:    { type: "string", description: t("toolDef.generateImage.qualityDesc") },
    model:      { type: "string", description: t("toolDef.generateImage.modelDesc") },
    provider:   { type: "string", description: t("toolDef.generateImage.providerDesc") },
    suggestedFilename: { type: "string", description: t("toolDef.generateImage.suggestedFilenameDesc") },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  let result;
  try {
    result = await submitImageGeneration({ input, ctx } as any);
  } catch (err) {
    return { content: [{ type: "text", text: err?.message || String(err) }] };
  }

  const text = t("toolDef.generateImage.submitted", { count: result.tasks.length });

  return {
    content: [{ type: "text", text }],
    details: {
      mediaGeneration: {
        kind: "image",
        batchId: result.batchId,
        prompt: input.prompt,
        tasks: result.tasks,
      },
    },
  };
}
