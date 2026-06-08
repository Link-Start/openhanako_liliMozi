import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf(") {", start) + 2;
  expect(bodyStart).toBeGreaterThan(1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated function ${name}`);
}

describe("desktop HTML preview native host", () => {
  it("creates a dedicated WebContentsView without renderer preload or Node access", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_createHtmlPreviewWebContentsView");

    expect(source).toContain("function _htmlPreviewPartition");
    expect(source).toContain("hana-html-preview:");
    expect(body).toContain("new WebContentsView");
    expect(body).toContain("session.fromPartition");
    expect(body).toContain("_htmlPreviewPartition(previewId)");
    expect(body).toContain("contextIsolation: true");
    expect(body).toContain("nodeIntegration: false");
    expect(body).toContain("sandbox: true");
    expect(body).not.toContain("preload:");
  });

  it("exposes IPC commands that show, move, and close the native HTML preview host", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('wrapIpcBestEffortHandler("html-preview-show"');
    expect(source).toContain('wrapIpcBestEffortHandler("html-preview-update-bounds"');
    expect(source).toContain('wrapIpcBestEffortHandler("html-preview-close"');
    expect(source).toContain("function _isAllowedHtmlPreviewUrl");
    expect(source).toContain("function _showHtmlPreviewView");
    expect(source).toContain("function _closeHtmlPreviewView");
  });

  it("only loads tokenized HTML preview documents from the local Hana server", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_isAllowedHtmlPreviewUrl");

    expect(body).toContain("serverPort");
    expect(body).toContain('url.pathname.startsWith("/preview/html/")');
    expect(body).toContain('url.port === String(serverPort)');
    expect(body).not.toContain('url.pathname.startsWith("/api/")');
  });
});
