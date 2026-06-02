import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

function functionBody(source, name) {
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

describe("desktop browser viewer window state", () => {
  it("does not wake secondary windows when showing the primary window", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "showPrimaryWindow");

    expect(body).toContain("focusExistingWindow(win)");
    expect(body).not.toContain("browserViewerWindow.show()");
    expect(body).not.toContain("settingsWindow.show()");
    expect(body).not.toContain("_viewerWindows");
  });

  it("hides the browser viewer when the active browser view is detached", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_detachActiveBrowserView");

    expect(body).toContain("contentView.removeChildView(view)");
    expect(body).toContain("_browserWebView = null");
    expect(body).toContain("_currentBrowserSession = null");
    expect(body).toContain('webContents.send("browser-update"');
    expect(body).toContain("browserViewerWindow.hide()");
  });

  it("routes close, suspend, destroy, and emergency stop through the detach helper", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('_detachActiveBrowserView({ view, sessionPath: sp || _currentBrowserSession, destroy: true, hideIfVisible: true })');
    expect(source).toContain('_detachActiveBrowserView({ view, sessionPath: sp || _currentBrowserSession, hideIfVisible: true })');
    expect(source).toContain('_detachActiveBrowserView({ view, sessionPath: sp, destroy: true, hideIfVisible: true })');
    expect(source).toContain('_detachActiveBrowserView({ destroy: true, hideIfVisible: true, reason: "emergency-stop" })');
  });
});
