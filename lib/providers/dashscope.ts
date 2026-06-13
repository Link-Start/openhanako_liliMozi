/**
 * DashScope provider plugin
 *
 * 阿里云百炼 OpenAI 兼容接口，承载 Qwen、MiniMax（通过 DashScope 转发）、
 * GLM、Kimi、SiliconFlow 等众多模型。
 *
 * 文档：https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */

import {
  COMMON_IMAGE_RATIOS,
  booleanParam,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
  stringParam,
} from "./media-schema-helpers.ts";

const WAN_PROPERTIES = {
  ratio: enumParam(COMMON_IMAGE_RATIOS, "1:1"),
  resolution: enumParam(["1K", "2K", "4K"], "1K"),
  size: stringParam(),
  n: integerParam({ minimum: 1, maximum: 4, defaultValue: 1 }),
  negative_prompt: stringParam(),
  prompt_extend: booleanParam(true),
  watermark: booleanParam(false),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const QWEN_20_PROPERTIES = {
  ratio: enumParam(["1:1", "16:9", "9:16", "4:3", "3:4"], "1:1"),
  size: stringParam("2048*2048"),
  n: integerParam({ minimum: 1, maximum: 6, defaultValue: 1 }),
  negative_prompt: stringParam(),
  prompt_extend: booleanParam(true),
  watermark: booleanParam(false),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const QWEN_TEXT_PROPERTIES = {
  ratio: enumParam(["16:9", "4:3", "1:1", "3:4", "9:16"], "16:9"),
  size: enumParam(["1664*928", "1472*1104", "1328*1328", "1104*1472", "928*1664"], "1664*928"),
  n: integerParam({ minimum: 1, maximum: 1, defaultValue: 1 }),
  negative_prompt: stringParam(),
  prompt_extend: booleanParam(true),
  watermark: booleanParam(false),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

function wanModel(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "dashscope-wan-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", WAN_PROPERTIES, {}, noReferenceImages()),
      mediaMode("image2image", "Image/reference to image", WAN_PROPERTIES, {}, referenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: ["1K", "2K", "4K"],
  };
}

function qwen20Model(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "dashscope-qwen-multimodal-image",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", QWEN_20_PROPERTIES, {}, noReferenceImages()),
      mediaMode("image2image", "Image edit/reference", QWEN_20_PROPERTIES, {}, referenceImages()),
    ],
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    resolutions: ["2K"],
  };
}

function qwenTextModel(id, displayName, aliases = undefined) {
  return {
    id,
    displayName,
    protocolId: "dashscope-qwen-text2image",
    inputs: ["text"],
    outputs: ["image"],
    ...(aliases ? { aliases } : {}),
    modes: [
      mediaMode("text2image", "Text to image", QWEN_TEXT_PROPERTIES, {}, noReferenceImages()),
    ],
    ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["1K"],
  };
}

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const dashscopePlugin = {
  id: "dashscope",
  displayName: "阿里云百炼 (DashScope)",
  authType: "api-key",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "wan2.7-image-pro",
        models: [
          wanModel("wan2.7-image-pro", "Wan 2.7 Image Pro", ["wan-2.7-pro"]),
          wanModel("wan2.7-image", "Wan 2.7 Image", ["wan-2.7"]),
          qwen20Model("qwen-image-2.0-pro", "Qwen Image 2.0 Pro", ["qwen-image-pro"]),
          qwenTextModel("qwen-image-plus", "Qwen Image Plus", ["qwen-image"]),
          qwenTextModel("qwen-image", "Qwen Image"),
        ],
      },
      speechRecognition: {
        defaultModelId: "qwen3-asr-flash",
        models: [
          { id: "qwen3-asr-flash", displayName: "Qwen3 ASR Flash", protocolId: "dashscope-qwen-asr-chat", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
