/**
 * Agnes AI provider plugin.
 *
 * Docs:
 * - Chat: https://agnes-ai.com/doc/agnes-20-flash
 * - Image: https://agnes-ai.com/doc/agnes-image-21-flash
 * - Video: https://agnes-ai.com/doc/agnes-video-v20
 */

import {
  COMMON_IMAGE_RATIOS,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  numberParam,
  referenceImages,
  stringParam,
} from "./media-schema-helpers.ts";

const AGNES_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"];

const AGNES_IMAGE_PROPERTIES = {
  ratio: enumParam(AGNES_IMAGE_RATIOS, "1:1"),
  size: stringParam(),
  resolution: enumParam(["1k"], "1k"),
};

const AGNES_VIDEO_PROPERTIES = {
  ratio: enumParam(COMMON_IMAGE_RATIOS, "16:9"),
  duration: numberParam({ minimum: 1, maximum: 18, defaultValue: 5 }),
  frame_rate: integerParam({ minimum: 1, maximum: 60, defaultValue: 24 }),
  num_frames: integerParam({ minimum: 1, maximum: 441 }),
  width: integerParam({ minimum: 256, maximum: 2048 }),
  height: integerParam({ minimum: 256, maximum: 2048 }),
};

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const agnesPlugin = {
  id: "agnes",
  displayName: "Agnes AI",
  authType: "api-key",
  defaultBaseUrl: "https://apihub.agnes-ai.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "agnes-image-2.1-flash",
        models: [
          {
            id: "agnes-image-2.1-flash",
            displayName: "Agnes Image 2.1 Flash",
            protocolId: "agnes-images",
            inputs: ["text", "image"],
            outputs: ["image"],
            supportsEdit: true,
            modes: [
              mediaMode("text2image", "Text to image", AGNES_IMAGE_PROPERTIES, {}, noReferenceImages()),
              mediaMode("image2image", "Image edit/reference", AGNES_IMAGE_PROPERTIES, {}, referenceImages()),
            ],
            ratios: AGNES_IMAGE_RATIOS,
            resolutions: ["1k"],
          },
        ],
      },
      videoGeneration: {
        defaultModelId: "agnes-video-v2.0",
        models: [
          {
            id: "agnes-video-v2.0",
            displayName: "Agnes Video V2.0",
            protocolId: "agnes-videos",
            inputs: ["text", "image"],
            outputs: ["video"],
            supportsAsync: true,
            modes: [
              mediaMode("text2video", "Text to video", AGNES_VIDEO_PROPERTIES, {}, noReferenceImages()),
              mediaMode("image2video", "Image to video", AGNES_VIDEO_PROPERTIES, {}, referenceImages({ max: 1 })),
              mediaMode("multiframe2video", "Multi-image to video", AGNES_VIDEO_PROPERTIES, {}, referenceImages({ min: 2 })),
            ],
            ratios: [...COMMON_IMAGE_RATIOS],
            resolutions: ["480p", "720p", "1080p"],
          },
        ],
      },
    },
  },
};
