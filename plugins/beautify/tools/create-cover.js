import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.js";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.js";

export const name = "create-cover";
export const description =
  "把一张已有图片应用为 Markdown Notion-like cover。若用户要求生成新封面，请先调用 beautify_get-cover-style-guide，再调用生图工具准备图片，最后用本工具写入 Markdown。";

export const promptGuidelines = [
  "Use beautify_create-cover only after an image already exists on disk.",
  "The image may come from image-gen, a built-in cover asset, or a user-selected local image.",
  "This tool does not read the article to design prompts, does not call any language model, and does not generate images.",
  "When the user asks to create/generate/replace/improve a Markdown cover from chat, first call beautify_get-cover-style-guide and read the target Markdown file before writing the image prompt.",
  "For a new Markdown cover, write the image prompt yourself using the style guide, call image-gen_generate-image with ratio 3:2, then call check_pending_tasks once to inspect whether a generated SessionFile is already available.",
  "After image generation resolves, pass the generated SessionFile filePath as generatedFilePath and the Markdown path as targetFilePath.",
  "If the target Markdown file path is not explicit and cannot be inferred from attached file metadata, ask the user to confirm the path before calling this tool.",
  "When called from an editor button, the file path is explicit; use it directly.",
  "For follow-up requests like 再生成一张 or 调整方向, call image-gen_generate-image again first, then call this tool with the new generated image path.",
].join("\n");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: "Markdown 文件绝对路径。路径不确定时先向用户确认。" },
    filePath: { type: "string", description: "targetFilePath 的兼容别名。" },
    generatedFilePath: { type: "string", description: "已有图片的绝对路径，可以来自生图工具、内置头图或用户本地图片。" },
    imageFilePath: { type: "string", description: "generatedFilePath 的兼容别名。" },
    pixelWidth: { type: "number", description: "图片像素宽，可选；不传时工具会尽量从图片头读取。" },
    pixelHeight: { type: "number", description: "图片像素高，可选；不传时工具会尽量从图片头读取。" },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

function resolveTargetFilePath(input) {
  return input.targetFilePath || input.filePath || input.target?.filePath || null;
}

function resolveGeneratedFilePath(input) {
  return input.generatedFilePath || input.imageFilePath || input.generated?.filePath || input.sessionFile?.filePath || null;
}

function textResult(text, details = undefined) {
  return {
    content: [{ type: "text", text }],
    ...(details ? { details } : {}),
  };
}

function emitMarkdownCoverUpdated(ctx, filePath) {
  try {
    ctx?.bus?.emit?.({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath },
        source: "server",
      },
    }, null);
  } catch (err) {
    ctx?.log?.warn?.(`markdown cover refresh event failed: ${err?.message || err}`);
  }
}

export async function execute(input, ctx) {
  const targetFilePath = resolveTargetFilePath(input);
  if (!targetFilePath || !path.isAbsolute(targetFilePath)) {
    return textResult("需要一个明确的 Markdown 文件绝对路径；如果你是从普通聊天里发起，请先确认目标文件路径。");
  }
  if (path.extname(targetFilePath).toLowerCase() !== ".md") {
    return textResult("目标文件必须是 .md Markdown 文件。");
  }

  const generatedFilePath = resolveGeneratedFilePath(input);
  if (!generatedFilePath || !path.isAbsolute(generatedFilePath)) {
    return textResult("需要已有图片的绝对路径 generatedFilePath。请先调用 image-gen_generate-image 并等待任务完成，或选择内置/本地图片后，把图片 filePath 传给本工具。");
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: targetFilePath,
      generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
    });
    emitMarkdownCoverUpdated(ctx, targetFilePath);
    return textResult("已把图片应用为 Markdown cover，并写入 frontmatter。", {
      beautifyCover: result,
    });
  } catch (err) {
    return textResult(`应用 cover 失败：${err?.message || err}`);
  }
}
