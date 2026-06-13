/**
 * Volcengine (火山引擎 / 豆包) provider plugin
 *
 * 注意：火山引擎的 model ID 实际是用户在控制台创建的 endpoint ID（如 ep-xxxxxx），
 * 不是标准模型名，故无默认模型列表，用户需通过设置页手动配置。
 *
 * 文档：https://www.volcengine.com/docs/82379/1399008
 */

import {
  COMMON_IMAGE_RATIOS,
  booleanParam,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  numberParam,
  referenceImages,
  stringParam,
} from "./media-schema-helpers.ts";

const SEEDREAM_BASE_PROPERTIES = {
  ratio: enumParam(COMMON_IMAGE_RATIOS, "1:1"),
  resolution: enumParam(["1k", "2k", "4k"], "2k"),
  size: stringParam(),
  watermark: booleanParam(false),
};

const SEEDREAM_3_PROPERTIES = {
  ...SEEDREAM_BASE_PROPERTIES,
  guidance_scale: numberParam({ minimum: 1, maximum: 10 }),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const SEEDREAM_5_PROPERTIES = {
  ...SEEDREAM_BASE_PROPERTIES,
  format: enumParam(["jpeg", "png"], "jpeg"),
};

function seedreamTextOnlyModel(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "volcengine-images",
    inputs: ["text"],
    outputs: ["image"],
    aliases,
    modes: [
      mediaMode("text2image", "文生图", SEEDREAM_3_PROPERTIES, {}, noReferenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: ["1k", "2k", "4k"],
  };
}

function seedreamReferenceModel(id, displayName, aliases, properties = SEEDREAM_BASE_PROPERTIES) {
  return {
    id,
    displayName,
    protocolId: "volcengine-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    aliases,
    supportsEdit: true,
    modes: [
      mediaMode("text2image", "文生图", properties, {}, noReferenceImages()),
      mediaMode("image2image", "参考图生图", properties, {}, referenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: ["1k", "2k", "4k"],
  };
}

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const volcenginePlugin = {
  id: "volcengine",
  displayName: "火山引擎 (豆包)",
  authType: "api-key",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "doubao-seedream-5-0-lite-260128",
        credentialLanes: [
          {
            id: "volcengine",
            providerId: "volcengine",
            label: "火山引擎 API Key",
          },
          {
            id: "volcengine-coding",
            providerId: "volcengine-coding",
            label: "火山引擎 Coding Plan",
          },
        ],
        models: [
          seedreamTextOnlyModel("doubao-seedream-3-0-t2i", "Seedream 3.0", ["3.0"]),
          seedreamReferenceModel("doubao-seedream-4-0-250828", "Seedream 4.0", ["4.0"]),
          seedreamReferenceModel("doubao-seedream-4-5-251128", "Seedream 4.5", ["4.5"]),
          seedreamReferenceModel("doubao-seedream-5-0-lite-260128", "Seedream 5.0 Lite", ["5.0", "5.0-lite"], SEEDREAM_5_PROPERTIES),
        ],
      },
    },
  },
};
