import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * tests/shell-surface-manifest.test.ts — guard test for build/shell-surface-manifest.json
 *
 * The manifest is a checked-in census of everything the Electron shell's
 * asar/extraResources actually ship (see build/shell-surface-manifest.json's
 * own "purpose" field). scripts/build-shell.mjs is written against this
 * census, not against package.json's electron-builder `build` config
 * directly — so if someone edits `build.files` / `build.extraResources` /
 * `build.mac.extraResources` / `build.win.extraResources` (or the
 * afterPack/afterSign hooks, or bumps the pinned Electron version) without
 * updating the manifest, this test must fail. Two independent directions:
 *
 *   1. Forward: every source path/glob the manifest declares must exist on
 *      disk (catches a manifest that documents something that was deleted
 *      or renamed).
 *   2. Reverse: every entry electron-builder's `build` config actually lists
 *      must have a matching manifest entry, keyed by the exact string(s)
 *      electron-builder itself uses (catches a manifest that fell behind a
 *      real change to package.json).
 *
 * Together these make "changed the shell surface, forgot the census"
 * mechanically fail instead of silently drifting.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath: string) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf-8"));
}

function stripLeadingDotSlash(p: string) {
  return p.startsWith("./") ? p.slice(2) : p;
}

const pkg = readJson("package.json");
const manifest = readJson("build/shell-surface-manifest.json");

// electron-builder's own ${os} token mapping (darwin -> mac, win32 -> win,
// linux -> linux) — same convention scripts/verify-seed-kit.mjs documents
// for the exact same reason (this file's own osDirNameFor()).
function currentBuilderOsTag() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

describe("shell-surface-manifest.json: forward (declared sources exist)", () => {
  it("declares an electron version that matches package.json's pinned devDependency", () => {
    expect(manifest.electron.version).toBe(pkg.devDependencies.electron);
  });

  it("declares a node engine range that matches package.json engines.node", () => {
    expect(manifest.nodeEngine).toBe(pkg.engines.node);
  });

  for (const dep of manifest.shellNativeDependencies) {
    it(`native dependency "${dep.name}" is present in package.json dependencies with the declared version`, () => {
      expect(pkg.dependencies[dep.name]).toBe(dep.declaredVersion);
    });
  }

  for (const entry of manifest.asarFiles) {
    if (!Array.isArray(entry.sourcePaths) && !entry.sourceGlob) continue; // exclusions have neither
    it(`asarFiles["${entry.builderEntry}"] source path(s) exist`, () => {
      if (entry.sourceGlob) {
        const matches = fs.globSync(entry.sourceGlob, { cwd: ROOT });
        expect(matches.length).toBeGreaterThan(0);
      }
      for (const sourcePath of entry.sourcePaths || []) {
        expect(fs.existsSync(path.join(ROOT, sourcePath)), `missing source path: ${sourcePath}`).toBe(true);
      }
    });
  }

  for (const entry of manifest.extraResources) {
    const isVendoredBinaryOnAnotherHost = entry.kind === "vendoredBinary"
      && entry.platform !== "all"
      && entry.platform !== currentBuilderOsTag();
    it(`extraResources["${entry.builderEntry}"] source path(s) exist${isVendoredBinaryOnAnotherHost ? " (skipped: vendored binary for another platform)" : ""}`, () => {
      if (isVendoredBinaryOnAnotherHost) return;
      for (const sourcePath of entry.sourcePaths || []) {
        expect(fs.existsSync(path.join(ROOT, sourcePath)), `missing source path: ${sourcePath}`).toBe(true);
      }
    });
  }

  // MinGit is gitignored under vendor/ and only extracted by Windows pack CI
  // (scripts/download-mingit.js). The forward check must point at the
  // downloader script — never at vendor/mingit itself — otherwise plain
  // `npm test` on windows-latest fails even though the pack pipeline is fine.
  it("win mingit vendoredBinary declares the downloader script, not the gitignored extracted tree", () => {
    const mingit = manifest.extraResources.find(
      (e: { builderEntry: string }) => e.builderEntry === "vendor/mingit -> git",
    );
    expect(mingit).toBeTruthy();
    expect(mingit.kind).toBe("vendoredBinary");
    expect(mingit.platform).toBe("win");
    expect(mingit.sourcePaths).toEqual(["scripts/download-mingit.js"]);
    expect(mingit.buildScript).toBe("scripts/download-mingit.js");
    expect(mingit.sourcePaths).not.toContain("vendor/mingit");
  });

  for (const hook of manifest.buildHooks) {
    it(`buildHooks "${hook.hook}" script exists at ${hook.script}`, () => {
      expect(fs.existsSync(path.join(ROOT, hook.script))).toBe(true);
    });
  }
});

describe("shell-surface-manifest.json: reverse (electron-builder config is fully covered)", () => {
  it("every package.json build.files entry has a matching manifest.asarFiles entry (and vice versa)", () => {
    const builderEntries = new Set(pkg.build.files as string[]);
    const manifestEntries = new Set(manifest.asarFiles.map((e: { builderEntry: string }) => e.builderEntry));
    for (const entry of builderEntries) {
      expect(manifestEntries.has(entry), `package.json build.files entry not covered by manifest: ${entry}`).toBe(true);
    }
    for (const entry of manifestEntries) {
      expect(builderEntries.has(entry as string), `manifest.asarFiles entry has no matching package.json build.files entry (stale?): ${entry}`).toBe(true);
    }
  });

  function reverseCheckExtraResources(builderList: Array<{ from: string; to: string }>, platformTag: string, label: string) {
    const builderEntries = new Set(builderList.map((e) => `${e.from} -> ${e.to}`));
    const manifestEntries = new Set(
      manifest.extraResources
        .filter((e: { platform: string }) => e.platform === platformTag)
        .map((e: { builderEntry: string }) => e.builderEntry),
    );
    for (const entry of builderEntries) {
      expect(manifestEntries.has(entry), `${label} extraResources entry not covered by manifest: ${entry}`).toBe(true);
    }
    for (const entry of manifestEntries) {
      expect(builderEntries.has(entry as string), `manifest extraResources entry (platform=${platformTag}) has no matching ${label} entry (stale?): ${entry}`).toBe(true);
    }
  }

  it("every top-level package.json build.extraResources entry has a matching manifest entry (platform=all, and vice versa)", () => {
    reverseCheckExtraResources(pkg.build.extraResources, "all", "package.json build.extraResources");
  });

  it("every package.json build.mac.extraResources entry has a matching manifest entry (platform=mac, and vice versa)", () => {
    reverseCheckExtraResources(pkg.build.mac.extraResources, "mac", "package.json build.mac.extraResources");
  });

  it("every package.json build.win.extraResources entry has a matching manifest entry (platform=win, and vice versa)", () => {
    reverseCheckExtraResources(pkg.build.win.extraResources, "win", "package.json build.win.extraResources");
  });

  it("afterPack/afterSign hooks match package.json build config", () => {
    const afterPack = stripLeadingDotSlash(pkg.build.afterPack);
    const afterSign = stripLeadingDotSlash(pkg.build.afterSign);
    const manifestScripts = manifest.buildHooks.map((h: { script: string }) => stripLeadingDotSlash(h.script));
    expect(manifestScripts).toContain(afterPack);
    expect(manifestScripts).toContain(afterSign);
  });
});

describe("shell-surface-manifest.json: build:theme attribution to renderer holds", () => {
  const rendererHtmlEntries = ["index.html", "mobile.html", "settings.html", "quick-chat.html", "onboarding.html", "browser-viewer.html"];

  it("vite.config.theme.js still outputs into desktop/dist-renderer (not a shell-owned directory)", () => {
    const themeConfig = fs.readFileSync(path.join(ROOT, "vite.config.theme.js"), "utf-8");
    expect(themeConfig).toContain("dist-renderer");
  });

  for (const htmlFile of rendererHtmlEntries) {
    it(`${htmlFile} (a renderer entry, not shipped in asar) references lib/theme.js`, () => {
      const html = fs.readFileSync(path.join(ROOT, "desktop/src", htmlFile), "utf-8");
      expect(html).toContain("lib/theme.js");
    });
  }

  it("splash.html (the one shell-owned HTML surface) does NOT reference lib/theme.js", () => {
    const splashHtml = fs.readFileSync(path.join(ROOT, "desktop/src/splash.html"), "utf-8");
    expect(splashHtml).not.toContain("lib/theme.js");
  });

  it("build:theme is listed as excluded from build:shell's step list", () => {
    expect(manifest.buildShellSteps.join(" ")).not.toContain("build:theme");
    expect(manifest.excludedFromShell.some((e: { script: string }) => e.script === "build:theme")).toBe(true);
  });
});
