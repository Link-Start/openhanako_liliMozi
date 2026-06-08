/**
 * artifact-tool.js — Artifact 旧预览工具（create_artifact）
 *
 * 只作为旧 session 的兼容层保留。新 session 不再注册此工具；Agent 应直接
 * write 文件并通过 stage_files 交给消费端。这里仍把旧调用写入 session-files
 * 管理缓存，让老历史进入 StageFile 生命周期。
 */
import fs from "fs/promises";
import path from "path";
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { sessionFilesCacheDir } from "../session-files/session-file-registry.ts";
import { serializeSessionFile } from "../session-files/session-file-response.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { t } from "../i18n.ts";

let _counter = 0;

export function createArtifactTool({ getHanakoHome, registerSessionFile, getSessionPath }: { getHanakoHome?: any; registerSessionFile?: any; getSessionPath?: any } = {}) {
  return {
    name: "create_artifact",
    label: "Create Preview",
    description: "Call this tool when you need to show the user an HTML page, code snippet, or long-form Markdown content.\nContent is rendered in a standalone preview panel where the user can view results in real time.\nGood for: runnable HTML/CSS/JS pages, interactive visualizations, SVG charts, complete code files, long formatted documents.\nNot for: short text replies, conversational answers, one-line code snippets (just show those inline).",
    parameters: Type.Object({
      type: StringEnum(
        ["html", "code", "markdown"],
        { description: "Content type: html (rendered page), code (syntax highlighted), markdown (document)" },
      ),
      title: Type.String({ description: "Display title, a short description of the content" }),
      content: Type.String({ description: "Full content (HTML source / code / Markdown text)" }),
      language: Type.Optional(
        Type.String({
          description: "Programming language (only for type=code), e.g. javascript, python, css",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const artifactId = `art-${Date.now()}-${++_counter}`;
      const artifactFile = await persistArtifactFile({
        artifactId,
        params,
        ctx,
        getHanakoHome,
        registerSessionFile,
        getSessionPath,
      });
      return {
        content: [{ type: "text", text: t("error.artifactCreated", { title: params.title }) }],
        details: {
          artifactId,
          type: params.type,
          title: params.title,
          content: params.content,
          language: params.language || null,
          ...(artifactFile ? flattenArtifactFile(artifactFile) : {}),
          ...(artifactFile ? { artifactFile } : {}),
        },
      };
    },
  };
}

async function persistArtifactFile({
  artifactId,
  params,
  ctx,
  getHanakoHome,
  registerSessionFile,
  getSessionPath,
}) {
  if (typeof registerSessionFile !== "function") return null;
  const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || getSessionPath?.() || null;
  if (!sessionPath) return null;
  const hanakoHome = getHanakoHome?.() || null;
  if (!hanakoHome) throw new Error("create_artifact requires hanakoHome to persist generated artifacts");

  const ext = artifactExt(params);
  const label = `${safeFilenameBase(params.title || "artifact")}.${ext}`;
  const filename = `${safeFilenameBase(params.title || "artifact")}-${artifactId}.${ext}`;
  const dir = sessionFilesCacheDir(hanakoHome, sessionPath);
  const filePath = path.join(dir, filename);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, params.content || "", "utf-8");

  return serializeSessionFile(await registerSessionFile({
    sessionPath,
    filePath,
    label,
    origin: "agent_artifact",
    storageKind: "managed_cache",
  }));
}

function flattenArtifactFile(file) {
  if (!file) return {};
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.origin ? { origin: file.origin } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
  };
}

function artifactExt(params) {
  if (params.type === "html") return "html";
  if (params.type === "markdown") return "md";
  const language = String(params.language || "").trim().toLowerCase();
  return CODE_LANGUAGE_EXT[language] || "txt";
}

const CODE_LANGUAGE_EXT = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  json: "json",
  yaml: "yaml",
  yml: "yml",
  css: "css",
  sql: "sql",
  rust: "rs",
  go: "go",
  java: "java",
};

function safeFilenameBase(title) {
  const base = String(title)
    .trim()
    .replace(/[<>:"/\\|?*]/g, " ")
    .split("")
    .map((char) => (char.charCodeAt(0) <= 0x1F ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return base || "artifact";
}
