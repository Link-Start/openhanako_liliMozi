// plugins/image-gen/adapters/openai.js
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.ts";
import { resolveModelId } from "../lib/model-catalog.ts";
import {
  IMAGE_RESOLUTION_TIERS,
  OPENAI_IMAGE_RATIOS,
  resolveOpenAiImageSize,
} from "../lib/resolution-tiers.ts";
import { t } from "../../../lib/i18n.ts";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function normalizeImages(image) {
  if (!image) return [];
  return (Array.isArray(image) ? image : [image]).filter((item) => typeof item === "string" && item.trim());
}

function imageMime(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "image/png";
}

function imageJsonRef(image) {
  if (/^https?:\/\//i.test(image)) return { image_url: image };
  if (/^file-[A-Za-z0-9_-]+/.test(image)) return { file_id: image };
  return null;
}

function buildEditJsonBody(body, images) {
  const refs = images.map(imageJsonRef);
  if (refs.every(Boolean)) return { ...body, images: refs };
  return null;
}

function buildEditMultipartBody(body, images) {
  if (!images.every((img) => path.isAbsolute(img) && fs.existsSync(img))) return null;
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const image of images) {
    const buf = fs.readFileSync(image);
    form.append("image[]", new Blob([buf], { type: imageMime(image) }), path.basename(image));
  }
  return form;
}

export const openaiImageAdapter = {
  id: "openai",
  protocolId: "openai-images",
  name: "OpenAI Image",
  types: ["image"],
  capabilities: {
    ratios: [...OPENAI_IMAGE_RATIOS],
    resolutions: [...IMAGE_RESOLUTION_TIERS],
  },

  async checkAuth(ctx) {
    try {
      const creds = await ctx.bus.request("provider:credentials", { providerId: "openai" });
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || t("plugin.imageGen.apiKeyNotConfigured") };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    // 1. Fetch credentials
    const providerId = params.credentialProviderId || params.providerId || "openai";
    const creds = await ctx.bus.request("provider:credentials", { providerId });
    if (creds.error || !creds.apiKey) {
      throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
    }

    const { apiKey, baseUrl } = creds;

    // 2. Resolve model — short names resolved via shared catalog
    const rawModel = params.modelId || params.model || ctx.config?.get?.("defaultImageModel")?.id || "gpt-image-1.5";
    const modelId = resolveModelId("openai", rawModel);

    // 3. Get provider defaults
    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults["openai"] || {};

    // 4. Translate params → API body
    const outputFormat = params.format || providerDefaults?.format || "jpeg";
    const effectiveRatio = params.aspect_ratio || params.aspectRatio || params.ratio || providerDefaults?.aspect_ratio;
    const body: any = {
      model: modelId,
      prompt: params.prompt,
      n: 1,
      output_format: outputFormat,
    };

    const size = resolveOpenAiImageSize(
      { ...params, ratio: effectiveRatio },
      providerDefaults,
      {
        sourceName: "OpenAI image",
        flexible: String(modelId).startsWith("gpt-image-2"),
      },
    );
    if (size) body.size = size;

    const quality = params.quality || providerDefaults?.quality;
    if (quality) body.quality = quality;

    if (providerDefaults?.background) body.background = providerDefaults.background;

    const images = normalizeImages(params.image);

    // 6. Call HTTP API — OpenAI gpt-image 用 /images/edits 做图生图
    const base = baseUrl.replace(/\/+$/, "");
    const endpoint = images.length > 0
      ? `${base}/images/edits`
      : `${base}/images/generations`;
    const jsonEditBody = images.length > 0 ? buildEditJsonBody(body, images) : null;
    const multipartEditBody = images.length > 0 && !jsonEditBody ? buildEditMultipartBody(body, images) : null;
    if (images.length > 0 && !jsonEditBody && !multipartEditBody) {
      throw new Error("OpenAI image edit reference must be an HTTP(S) URL, file_id, or local image file path");
    }
    const requestBody = images.length > 0 ? (multipartEditBody || JSON.stringify(jsonEditBody)) : JSON.stringify(body);
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
    };
    if (!multipartEditBody) headers["Content-Type"] = "application/json";

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: requestBody,
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const responseImages = data.data || [];
    if (responseImages.length === 0) {
      throw new Error("API returned no images");
    }

    const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";

    // Note revised_prompt in log if present (not surfaced to caller)
    const revisedPrompt = responseImages[0]?.revised_prompt;
    if (revisedPrompt) {
      ctx.log?.info?.(`[openai-image] revised_prompt: ${revisedPrompt}`);
    }

    // 7. Save files using saveImage() — it appends /generated/ internally, so pass ctx.dataDir
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const files = [];
    for (let i = 0; i < responseImages.length; i++) {
      const buffer = Buffer.from(responseImages[i].b64_json, "base64");
      const customName = params.filename
        ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
        : null;
      const { filename } = await saveImage(buffer, mimeType, ctx.dataDir, customName);
      files.push(filename);
    }

    // 8. Return taskId + files
    return { taskId, files };
  },
  // No query() needed — files returned in submit = fake-async
};
