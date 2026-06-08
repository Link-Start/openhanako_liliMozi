/**
 * Google Gemini provider plugin
 *
 * 通过 Gemini native API 接入。Gemini 3 工具调用需要保留
 * thoughtSignature，Pi SDK 的 google-generative-ai provider 已处理该协议。
 * 文档：https://ai.google.dev/gemini-api/docs
 */

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const geminiPlugin = {
  id: "gemini",
  displayName: "Google Gemini",
  authType: "api-key",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  defaultApi: "google-generative-ai",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "gemini-3.1-flash-image-preview",
        models: [
          { id: "gemini-2.5-flash-image", displayName: "Gemini 2.5 Flash Image", protocolId: "gemini-generate-content-image", inputs: ["text", "image"], outputs: ["image"], aliases: ["nano-banana"] },
          { id: "gemini-3.1-flash-image-preview", displayName: "Gemini 3.1 Flash Image Preview", protocolId: "gemini-generate-content-image", inputs: ["text", "image"], outputs: ["image"], aliases: ["nano-banana-2"] },
          { id: "gemini-3-pro-image-preview", displayName: "Gemini 3 Pro Image Preview", protocolId: "gemini-generate-content-image", inputs: ["text", "image"], outputs: ["image"], aliases: ["nano-banana-pro"] },
        ],
      },
    },
  },
};
