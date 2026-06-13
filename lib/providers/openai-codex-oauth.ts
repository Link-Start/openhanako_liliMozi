/**
 * OpenAI Codex OAuth provider plugin
 *
 * 通过 OAuth 接入，对应 auth.json 中的 openai-codex 条目。
 */

import {
  OPENAI_IMAGE_RATIOS,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
  stringParam,
} from "./media-schema-helpers.ts";

const GPT_IMAGE_2_PROPERTIES = {
  ratio: enumParam(OPENAI_IMAGE_RATIOS, "1:1"),
  resolution: enumParam(["1k", "2k", "4k"], "1k"),
  size: stringParam("auto"),
  quality: enumParam(["auto", "low", "medium", "high"], "auto"),
  format: enumParam(["png", "jpeg", "webp"], "png"),
  background: enumParam(["auto", "opaque"], "auto"),
  output_compression: integerParam({ minimum: 0, maximum: 100 }),
};

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const openaiCodexOAuthPlugin = {
  id: "openai-codex-oauth",
  displayName: "OpenAI Codex (OAuth)",
  authType: "oauth",
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  defaultApi: "openai-codex-responses",
  authJsonKey: "openai-codex",
  capabilities: {
    chat: {
      runtimeProviderId: "openai-codex",
      displayProviderId: "openai-codex",
      projection: "sdk-auth-alias",
      allowListSource: "provider.models",
    },
    media: {
      imageGeneration: {
        defaultModelId: "gpt-image-2",
        credentialLanes: [
          {
            id: "codex-oauth",
            providerId: "openai-codex-oauth",
            authJsonKey: "openai-codex",
            label: "Codex OAuth",
          },
        ],
        models: [
          {
            id: "gpt-image-2",
            displayName: "GPT Image 2",
            protocolId: "openai-codex-responses-image",
            credentialLaneId: "codex-oauth",
            inputs: ["text", "image"],
            outputs: ["image"],
            supportsEdit: true,
            aliases: ["2", "image-2"],
            modes: [
              mediaMode("text2image", "Text to image", GPT_IMAGE_2_PROPERTIES, {}, noReferenceImages()),
              mediaMode("image2image", "Image edit/reference", GPT_IMAGE_2_PROPERTIES, {}, referenceImages()),
            ],
            ratios: [...OPENAI_IMAGE_RATIOS],
            resolutions: ["1k", "2k", "4k"],
          },
        ],
      },
    },
  },
};
