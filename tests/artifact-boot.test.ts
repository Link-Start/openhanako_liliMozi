import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  hasSeed,
  verifySeedManifest,
  decideBootAction,
  prepareArtifactServerBoot,
  prepareArtifactRendererBoot,
  prepareArtifactBoot,
  writeBootSentinel,
  scheduleHealthySentinelClear,
  rendererPointerChannel,
  isRendererMainFrameLoadCrash,
  isRenderProcessGoneCrash,
  SEED_CHANNEL,
} = require("../desktop/src/shared/artifact-boot.cjs");

const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");

const PLATFORM_ARCH = "darwin-arm64";
const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeKeys(keyId = "boot-test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    keyset: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  };
}

/**
 * Builds a complete Resources-like dir carrying a signed server-only seed
 * (the exact layout build-server-artifact.mjs produces under seed/).
 */
async function makeSeedResources(root: string, keys: ReturnType<typeof makeKeys>, opts: { version?: string; marker?: string; train?: number } = {}) {
  const version = opts.version ?? "1.0.0";
  const marker = opts.marker ?? "server-v1";
  const resourcesPath = path.join(root, `resources-${version}-${marker}`);
  const seedDir = path.join(resourcesPath, "seed");
  const treeDir = path.join(root, `tree-${version}-${marker}`);
  await fsp.mkdir(path.join(treeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(treeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  await fsp.writeFile(path.join(treeDir, "hana-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const archiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  await fsp.mkdir(seedDir, { recursive: true });
  const archivePath = path.join(seedDir, archiveName);
  await ustar.packTree(treeDir, archivePath);
  const sha256 = await activation.sha256File(archivePath);

  const manifest = {
    schema: 1,
    train: opts.train ?? 0,
    channel: "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: version,
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "seed" },
    artifacts: {
      server: { [PLATFORM_ARCH]: { version, sha256, size: fs.statSync(archivePath).size, path: archiveName } },
    },
    mirrors: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`), manifestBytes);
  await fsp.writeFile(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`), cryptoSign(null, manifestBytes, keys.privateKey));
  return { resourcesPath, seedDir, manifest, sha256 };
}

/**
 * Builds a complete Resources-like dir carrying a signed DUAL-kind seed
 * (renderer + server, matching the layout produced by packDualKindSeed).
 * Used to test the renderer resolution path and the combined
 * `prepareArtifactBoot` orchestrator.
 */
async function makeDualKindSeedResources(
  root: string,
  keys: ReturnType<typeof makeKeys>,
  opts: { version?: string; marker?: string; train?: number; omitRenderer?: boolean } = {},
) {
  const version = opts.version ?? "1.0.0";
  const marker = opts.marker ?? "dual-v1";
  const resourcesPath = path.join(root, `resources-${version}-${marker}`);
  const seedDir = path.join(resourcesPath, "seed");
  await fsp.mkdir(seedDir, { recursive: true });

  const serverTreeDir = path.join(root, `server-tree-${version}-${marker}`);
  await fsp.mkdir(path.join(serverTreeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(serverTreeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  await fsp.writeFile(path.join(serverTreeDir, "hana-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const serverArchiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  const serverArchivePath = path.join(seedDir, serverArchiveName);
  await ustar.packTree(serverTreeDir, serverArchivePath);
  const serverSha256 = await activation.sha256File(serverArchivePath);

  const rendererTreeDir = path.join(root, `renderer-tree-${version}-${marker}`);
  await fsp.mkdir(rendererTreeDir, { recursive: true });
  await fsp.writeFile(path.join(rendererTreeDir, "index.html"), `<!doctype html><!-- ${marker} -->\n`);
  const rendererArchiveName = `renderer-${version}.tar.gz`;
  const rendererArchivePath = path.join(seedDir, rendererArchiveName);
  await ustar.packTree(rendererTreeDir, rendererArchivePath);
  const rendererSha256 = await activation.sha256File(rendererArchivePath);

  const artifacts: Record<string, unknown> = {
    server: { [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName } },
  };
  if (!opts.omitRenderer) {
    artifacts.renderer = { version, sha256: rendererSha256, size: fs.statSync(rendererArchivePath).size, path: rendererArchiveName };
  }

  const manifest = {
    schema: 1,
    train: opts.train ?? 0,
    channel: "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: version,
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "seed" },
    artifacts,
    mirrors: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`), manifestBytes);
  await fsp.writeFile(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`), cryptoSign(null, manifestBytes, keys.privateKey));
  return { resourcesPath, seedDir, manifest, serverSha256, rendererSha256 };
}

describe("artifact-boot: seed presence and verification", () => {
  it("hasSeed is false when no seed dir exists", () => {
    const root = makeTempDir("hana-boot-");
    expect(hasSeed(path.join(root, "nowhere"), PLATFORM_ARCH)).toBe(false);
  });

  it("hard-errors when the seed manifest lacks a server entry for the running platform", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeSeedResources(root, keys);
    const manifestBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`));
    const sigBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`));
    expect(() =>
      verifySeedManifest({ manifestBytes, sigBytes, keyset: keys.keyset, platformArch: "win32-x64" }),
    ).toThrow(/win32-x64/);
  });

  it("rejects a tampered seed manifest signature", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath, seedDir } = await makeSeedResources(root, keys);
    const sigPath = path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`);
    const sig = fs.readFileSync(sigPath);
    sig[0] ^= 0xff;
    fs.writeFileSync(sigPath, sig);

    const homeDir = path.join(root, "home");
    await expect(
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });
});

describe("artifact-boot: decideBootAction (pure)", () => {
  const seedEntry = { sha256: "a".repeat(64), version: "2.0.0" };

  it("activates the seed when nothing is resolved (first run)", () => {
    expect(decideBootAction({ resolved: null, seedEntry, crashFallback: false })).toBe("activate-seed");
  });

  it("boots the resolved pointer when it matches the bundled seed", () => {
    const resolved = { slot: "current", pointer: { sha256: "a".repeat(64), train: 0, version: "2.0.0" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("activates a strictly newer packaged seed over an older OTA train", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 7, version: "1.9.9" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("activate-seed");
  });

  it("keeps an equal-version current pointer even when its content and train differ", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 0, version: "2.0.0" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("never downgrades a current pointer that is newer than the packaged seed", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 0, version: "2.0.1" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("preserves the legacy train-0 sha mismatch rule when versions cannot be compared", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 0, version: "legacy" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("activate-seed");
  });

  it("preserves the legacy OTA-train priority when versions cannot be compared", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 7, version: "legacy" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("never forces the seed over a crash-fallback target", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 7, version: "1.0.0" } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: true })).toBe("boot");
  });
});

describe("artifact-boot: prepareArtifactServerBoot", () => {
  it("first run extracts the seed, promotes it to current, and returns its versioned dir", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    let progressCalls = 0;

    const result = await prepareArtifactServerBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      onProgress: () => {
        progressCalls += 1;
      },
      log: () => {},
    });

    expect(result.activatedSeed).toBe(true);
    expect(progressCalls).toBe(1);
    expect(result.train).toBe(0);
    expect(fs.existsSync(path.join(result.versionDir, "bundle", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.versionDir, ".verified"))).toBe(true);
    const current = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "current");
    expect(current.versionDir).toBe(result.versionDir);
  });

  it("second boot skips extraction (pointer hit)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = (onProgress?: () => void) =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        onProgress,
        log: () => {},
      });

    const first = await boot();
    let progressCalls = 0;
    const second = await boot(() => {
      progressCalls += 1;
    });

    expect(second.activatedSeed).toBe(false);
    expect(progressCalls).toBe(0);
    expect(second.versionDir).toBe(first.versionDir);
  });

  it("re-extracts the seed when the activated tree is corrupted", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    const first = await boot();
    fs.rmSync(path.join(first.versionDir, ".verified"));

    const second = await boot();
    expect(second.activatedSeed).toBe(true);
    expect(fs.existsSync(path.join(second.versionDir, ".verified"))).toBe(true);
  });

  it("activates the NEW seed after an installer update (same train 0, different content)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const oldSeed = await makeSeedResources(root, keys, { version: "1.0.0", marker: "old" });
    const newSeed = await makeSeedResources(root, keys, { version: "1.1.0", marker: "new" });
    const homeDir = path.join(root, "home");
    const boot = (resourcesPath: string) =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    await boot(oldSeed.resourcesPath);
    const afterUpdate = await boot(newSeed.resourcesPath);

    expect(afterUpdate.activatedSeed).toBe(true);
    expect(fs.readFileSync(path.join(afterUpdate.versionDir, "bundle", "index.js"), "utf8")).toContain("new");
  });

  it("three consecutive failures on an OTA train quarantine it and fall back to previous", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const seed = await makeSeedResources(root, keys, { version: "1.0.0", marker: "seedgen" });
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath: seed.resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    // Boot once: seed (train 0) becomes current.
    const seedBoot = await boot();

    // Simulate an OTA-activated train 7 landing on top (previous = seed).
    const ota = await makeSeedResources(root, keys, { version: "2.0.0", marker: "ota", train: 7 });
    const otaArchive = path.join(ota.seedDir, `server-2.0.0-${PLATFORM_ARCH}.tar.gz`);
    await activation.activateFromArchive(otaArchive, ota.manifest, {
      homeDir,
      channel: SEED_CHANNEL,
      kind: "server",
      platformArch: PLATFORM_ARCH,
    });
    const otaBoot = await boot();
    expect(otaBoot.train).toBe(7);
    expect(otaBoot.versionDir).not.toBe(seedBoot.versionDir);

    // Three consecutive boot failures on train 7.
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.train).toBe(0);
    expect(fallback.versionDir).toBe(seedBoot.versionDir);
    expect(fallback.quarantinedTrain).toBe(7);
    expect(await pointerStore.isQuarantined(homeDir, SEED_CHANNEL, 7)).toBe(true);
    // Crash-fallback notice payload: the version that just failed (train 7's
    // "2.0.0") and the version it fell back to (the seed's "1.0.0") — this is
    // what desktop/main.cjs surfaces to the user via the sidebar notice card.
    expect(fallback.fromVersion).toBe("2.0.0");
    expect(fallback.toVersion).toBe("1.0.0");
  });

  it("does not populate fromVersion/toVersion when no crash fallback occurred", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const seed = await makeSeedResources(root, keys, { version: "1.0.0", marker: "seedgen" });
    const homeDir = path.join(root, "home");

    const result = await prepareArtifactServerBoot({
      homeDir,
      resourcesPath: seed.resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });

    expect(result.crashFallback).toBe(false);
    expect(result.fromVersion).toBe(null);
    expect(result.toVersion).toBe(null);
  });

  it("three failures on the seed itself never quarantine train 0 (seed stays the terminal fallback)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const seed = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath: seed.resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    const first = await boot();
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.versionDir).toBe(first.versionDir);
    expect(fallback.quarantinedTrain).toBe(null);
    expect(await pointerStore.isQuarantined(homeDir, SEED_CHANNEL, 0)).toBe(false);
    // Fallback resets the sentinel so the fallback target gets a fresh count.
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(0);
  });

  it("hard-errors when packaged resources carry no seed at all (no silent dev fallback)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    await expect(
      prepareArtifactServerBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });
});

describe("artifact-boot: verifySeedManifest requiredKinds", () => {
  it("hard-errors when requiredKinds includes renderer but the manifest carries none", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeSeedResources(root, keys); // server-only fixture
    const manifestBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`));
    const sigBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`));
    expect(() =>
      verifySeedManifest({ manifestBytes, sigBytes, keyset: keys.keyset, requiredKinds: ["renderer"] }),
    ).toThrow(/renderer/i);
  });

  it("returns both entries when requiredKinds asks for server and renderer on a dual-kind manifest", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeDualKindSeedResources(root, keys);
    const manifestBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`));
    const sigBytes = fs.readFileSync(path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json.sig`));
    const result = verifySeedManifest({
      manifestBytes,
      sigBytes,
      keyset: keys.keyset,
      platformArch: PLATFORM_ARCH,
      requiredKinds: ["server", "renderer"],
    });
    expect(result.serverEntry).toBeDefined();
    expect(result.rendererEntry).toBeDefined();
  });
});

describe("artifact-boot: prepareArtifactRendererBoot", () => {
  it("first run extracts the renderer seed and returns its versioned dir", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    let progressCalls = 0;

    const result = await prepareArtifactRendererBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      onProgress: () => {
        progressCalls += 1;
      },
      log: () => {},
    });

    expect(result.activatedSeed).toBe(true);
    expect(progressCalls).toBe(1);
    expect(result.train).toBe(0);
    expect(fs.existsSync(path.join(result.versionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.versionDir, ".verified"))).toBe(true);
  });

  it("second boot skips extraction (pointer hit)", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactRendererBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });

    const first = await boot();
    const second = await boot();
    expect(second.activatedSeed).toBe(false);
    expect(second.versionDir).toBe(first.versionDir);
  });

  it("does not collide with the server pointer namespace under the same channel", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    const server = await prepareArtifactServerBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });
    const renderer = await prepareArtifactRendererBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });

    // Distinct pointer files: server's "stable.current.json" must survive
    // renderer's own promote() untouched.
    const serverCurrent = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "current");
    expect(serverCurrent.kind).toBe("server");
    expect(serverCurrent.versionDir).toBe(server.versionDir);
    expect(renderer.versionDir).not.toBe(server.versionDir);
    expect(fs.existsSync(path.join(renderer.versionDir, "index.html"))).toBe(true);
  });

  it("hard-errors when packaged resources carry no seed at all", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    await expect(
      prepareArtifactRendererBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });

  // artifact recovery: renderer crash-loop demotion, isomorphic to
  // prepareArtifactServerBoot's (mirrors the two "three consecutive
  // failures" tests above, but against the renderer's own pointer
  // namespace `${channel}.renderer`).
  it("three consecutive failures on an OTA renderer train quarantine it and fall back to previous", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const seed = await makeDualKindSeedResources(root, keys, { version: "1.0.0", marker: "seedgen" });
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactRendererBoot({ homeDir, resourcesPath: seed.resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });

    const seedBoot = await boot();

    const ota = await makeDualKindSeedResources(root, keys, { version: "2.0.0", marker: "ota", train: 7 });
    const otaArchive = path.join(ota.seedDir, `renderer-2.0.0.tar.gz`);
    const rendererChannel = rendererPointerChannel(SEED_CHANNEL);
    await activation.activateFromArchive(otaArchive, ota.manifest, {
      homeDir,
      channel: rendererChannel,
      kind: "renderer",
    });
    const otaBoot = await boot();
    expect(otaBoot.train).toBe(7);
    expect(otaBoot.versionDir).not.toBe(seedBoot.versionDir);

    await writeBootSentinel(homeDir, rendererChannel, 7);
    await writeBootSentinel(homeDir, rendererChannel, 7);
    await writeBootSentinel(homeDir, rendererChannel, 7);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.train).toBe(0);
    expect(fallback.versionDir).toBe(seedBoot.versionDir);
    expect(fallback.quarantinedTrain).toBe(7);
    expect(await pointerStore.isQuarantined(homeDir, rendererChannel, 7)).toBe(true);
    expect(fallback.fromVersion).toBe("2.0.0");
    expect(fallback.toVersion).toBe("1.0.0");
  });

  it("three failures on the renderer seed itself never quarantine train 0", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const seed = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactRendererBoot({ homeDir, resourcesPath: seed.resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });
    const rendererChannel = rendererPointerChannel(SEED_CHANNEL);

    const first = await boot();
    await writeBootSentinel(homeDir, rendererChannel, 0);
    await writeBootSentinel(homeDir, rendererChannel, 0);
    await writeBootSentinel(homeDir, rendererChannel, 0);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.versionDir).toBe(first.versionDir);
    expect(fallback.quarantinedTrain).toBe(null);
    expect(await pointerStore.isQuarantined(homeDir, rendererChannel, 0)).toBe(false);
    expect(await activation.consecutiveFailures(homeDir, rendererChannel)).toBe(0);
  });
});

describe("artifact-boot: renderer load-failure event guards (artifact recovery)", () => {
  it("treats a main-frame did-fail-load as a crash", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -6, isMainFrame: true })).toBe(true);
  });

  it("ignores sub-frame did-fail-load events regardless of error code", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -6, isMainFrame: false })).toBe(false);
  });

  it("ignores ERR_ABORTED (-3) on the main frame (benign cancelled navigation)", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -3, isMainFrame: true })).toBe(false);
  });

  it("treats render-process-gone as a crash unless the reason is clean-exit", () => {
    expect(isRenderProcessGoneCrash({ reason: "crashed" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "oom" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "killed" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "clean-exit" })).toBe(false);
  });
});

describe("artifact-boot: prepareArtifactBoot dual-kind orchestrator", () => {
  it("resolves both server and renderer on first run", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    const result = await prepareArtifactBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });

    expect(result.server.activatedSeed).toBe(true);
    expect(result.renderer.activatedSeed).toBe(true);
    expect(fs.existsSync(path.join(result.server.versionDir, "bundle", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.renderer.versionDir, "index.html"))).toBe(true);
  });

  it("activates a newer packaged seed over older OTA currents for both server and renderer", async () => {
    const root = makeTempDir("hana-boot-dual-seed-upgrade-");
    const keys = makeKeys();
    const oldSeed = await makeDualKindSeedResources(root, keys, { version: "1.0.0", marker: "old-seed" });
    const ota = await makeDualKindSeedResources(root, keys, { version: "1.1.0", marker: "old-ota", train: 7 });
    const newSeed = await makeDualKindSeedResources(root, keys, { version: "2.0.0", marker: "new-seed" });
    const homeDir = path.join(root, "home");

    await prepareArtifactBoot({
      homeDir,
      resourcesPath: oldSeed.resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });

    await activation.activateFromArchive(
      path.join(ota.seedDir, `server-1.1.0-${PLATFORM_ARCH}.tar.gz`),
      ota.manifest,
      { homeDir, channel: SEED_CHANNEL, kind: "server", platformArch: PLATFORM_ARCH },
    );
    await activation.activateFromArchive(
      path.join(ota.seedDir, "renderer-1.1.0.tar.gz"),
      ota.manifest,
      { homeDir, channel: rendererPointerChannel(SEED_CHANNEL), kind: "renderer" },
    );

    const result = await prepareArtifactBoot({
      homeDir,
      resourcesPath: newSeed.resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });

    expect(result.server).toMatchObject({ activatedSeed: true, train: 0, version: "2.0.0" });
    expect(result.renderer).toMatchObject({ activatedSeed: true, train: 0, version: "2.0.0" });
    expect(fs.readFileSync(path.join(result.server.versionDir, "bundle", "index.js"), "utf8")).toContain("new-seed");
    expect(fs.readFileSync(path.join(result.renderer.versionDir, "index.html"), "utf8")).toContain("new-seed");
  });

  // Mutation-check target: a manifest missing the
  // renderer kind must hard-error the WHOLE boot, not just silently boot
  // server alone. Flip `omitRenderer` to false to see this test go red.
  it("hard-errors the whole boot when the manifest is missing the renderer kind", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys, { omitRenderer: true });
    const homeDir = path.join(root, "home");

    await expect(
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} }),
    ).rejects.toThrow(/renderer/i);
  });

  it("hard-errors when the running platform has no bundled seed manifest at all (wrong-platform install)", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    // Fixture only ever writes the PLATFORM_ARCH ("darwin-arm64")-named
    // manifest — no seed-train-win32-x64.json exists in this Resources/
    // tree at all. Before manifests were platform-qualified, every
    // platform shared the same seed-train.json filename, so "wrong
    // platform" and "seed exists but its content doesn't cover you" were
    // indistinguishable at the file-lookup layer; disambiguating the
    // filename is the whole point of this change, so the two now produce
    // different errors (this test covers the first; the next test covers
    // the second).
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    await expect(
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: "win32-x64", keyset: keys.keyset, log: () => {} }),
    ).rejects.toThrow(/carry no seed/i);
  });

  it("hard-errors when a correctly-named manifest's signed content doesn't cover the platform it claims (build defect: filename/content platform mismatch)", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath, seedDir } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    // Doctor the manifest IN PLACE — same file name (seed-train-<PLATFORM_ARCH>.json,
    // so hasSeed/seedPaths still find it) — but repoint its artifacts.server
    // key at a DIFFERENT platform-arch and re-sign with the same key.
    // Reproduces a build defect where the filename and the signed content
    // disagree about which platform the kit is for (exactly the ambiguity
    // this change's per-platform naming is meant to make detectable).
    const manifestPath = path.join(seedDir, `seed-train-${PLATFORM_ARCH}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.artifacts.server = { "win32-x64": manifest.artifacts.server[PLATFORM_ARCH] };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(manifestPath, bytes);
    fs.writeFileSync(`${manifestPath}.sig`, cryptoSign(null, bytes, keys.privateKey));

    await expect(
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} }),
    ).rejects.toThrow(new RegExp(PLATFORM_ARCH));
  });

  it("hard-errors when packaged resources carry no seed at all", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    await expect(
      prepareArtifactBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });

  it("second boot resolves both kinds from pointer hits (no re-extraction)", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });

    const first = await boot();
    const second = await boot();
    expect(second.server.activatedSeed).toBe(false);
    expect(second.renderer.activatedSeed).toBe(false);
    expect(second.server.versionDir).toBe(first.server.versionDir);
    expect(second.renderer.versionDir).toBe(first.renderer.versionDir);
  });
});

describe("artifact-boot: sentinel helpers", () => {
  it("writeBootSentinel counts consecutive attempts and scheduleHealthySentinelClear clears them", async () => {
    const root = makeTempDir("hana-boot-");
    const homeDir = path.join(root, "home");
    await writeBootSentinel(homeDir, SEED_CHANNEL, 3);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 3);
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(2);

    scheduleHealthySentinelClear({ homeDir, channel: SEED_CHANNEL, delayMs: 10, log: () => {} });
    await new Promise((r) => setTimeout(r, 120));
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(0);
  });
});

// ── pointer mutex wiring (crash-vs-OTA-activation interleaving fix) ────────
//
// The bug this closes: `prepareArtifactServerBoot`/`prepareArtifactRendererBoot`
// call `pointerStore.promote` — a multi-step "read next -> write previous ->
// write current -> clear next" sequence — with no lock. If a concurrent
// in-process OTA activation (artifact-ota.cjs's `downloadAndApplyArtifacts`)
// writes a fresh `next` pointer between promote's read and its trailing
// clear, that fresh `next` gets silently wiped. `withPointerMutex` closes
// the window by serializing every in-process pointer mutation for a given
// homeDir. These tests exercise the wiring at two levels: (1) the two boot
// functions actually acquire the mutex before touching pointers, and (2) the
// interleaving itself, with and without the mutex.

describe("artifact-boot: pointer mutex wiring", () => {
  it("prepareArtifactServerBoot waits for an in-flight pointer-mutex holder before it starts", async () => {
    const root = makeTempDir("hana-boot-mutex-server-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const held = pointerStore.withPointerMutex(homeDir, () => hold);

    let completed = false;
    const bootPromise = prepareArtifactServerBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    }).then((result: unknown) => {
      completed = true;
      return result;
    });

    // Long enough that, absent the mutex, boot would already have raced
    // ahead and started reading/writing pointers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);

    releaseHold();
    await held;
    const result = await bootPromise;
    expect(completed).toBe(true);
    expect((result as { activatedSeed: boolean }).activatedSeed).toBe(true);
  });

  it("prepareArtifactRendererBoot waits for an in-flight pointer-mutex holder before it starts", async () => {
    const root = makeTempDir("hana-boot-mutex-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const held = pointerStore.withPointerMutex(homeDir, () => hold);

    let completed = false;
    const bootPromise = prepareArtifactRendererBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    }).then((result: unknown) => {
      completed = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);

    releaseHold();
    await held;
    const result = await bootPromise;
    expect(completed).toBe(true);
    expect((result as { activatedSeed: boolean }).activatedSeed).toBe(true);
  });
});

describe("artifact-boot: pointer mutex closes the promote-vs-concurrent-write race (mutation-check target)", () => {
  /**
   * Replays `pointerStore.promote`'s exact steps by hand (read next ->
   * write previous -> write current -> clear next) with an explicit hook
   * point right after "write current" — the same window a concurrent OTA
   * `next` write could land in before `withPointerMutex` existed. Used to
   * both document the pre-fix bug (called unwrapped) and prove the fix
   * (called with both sides wrapped in `withPointerMutex`).
   */
  async function unprotectedPromoteSequence(
    homeDir: string,
    channel: string,
    onAfterWriteCurrent?: () => void | Promise<void>,
  ) {
    const next = await pointerStore.readPointer(homeDir, channel, "next");
    if (!next) return { promoted: false };
    const current = await pointerStore.readPointer(homeDir, channel, "current");
    if (current) await pointerStore.writePointer(homeDir, channel, "previous", current);
    await pointerStore.writePointer(homeDir, channel, "current", next);
    if (onAfterWriteCurrent) await onAfterWriteCurrent();
    await pointerStore.clearPointer(homeDir, channel, "next");
    return { promoted: true, current: next };
  }

  it("documents the pre-fix race: a next-pointer write landing between promote's write-current and its trailing clear is silently dropped", async () => {
    const root = makeTempDir("hana-boot-mutex-loss-a-");
    const homeDir = path.join(root, "home");
    const channel = "stable-loss-repro-a";
    await pointerStore.writePointer(homeDir, channel, "current", { version: "1.0.0", train: 0 });
    await pointerStore.writePointer(homeDir, channel, "next", { version: "1.5.0", train: 5 });

    const freshNext = { version: "2.0.0", train: 6 };
    await unprotectedPromoteSequence(homeDir, channel, async () => {
      // Simulates a concurrent OTA activation writing (and fully
      // persisting — atomicWriteJson's rename included) its freshly-staged
      // `next` pointer right after promote wrote `current` but before it
      // cleared `next` — exactly the interleaving window `withPointerMutex`
      // closes. Awaited here (unlike the mutex-protected test below) since
      // this is a same-actor simulation with no lock to queue behind.
      await pointerStore.writePointer(homeDir, channel, "next", freshNext);
    });

    const lostNext = await pointerStore.readPointer(homeDir, channel, "next");
    expect(lostNext).toBeNull(); // the bug: freshNext is gone — the trailing clearPointer wiped it
    const currentAfterRace = await pointerStore.readPointer(homeDir, channel, "current");
    expect(currentAfterRace.train).toBe(5); // promote only ever consumed the OLD next it had already read
  });

  it("withPointerMutex closes the window: the same interleaving attempt never loses the concurrently-written next pointer", async () => {
    const root = makeTempDir("hana-boot-mutex-loss-b-");
    const homeDir = path.join(root, "home");
    const channel = "stable-loss-repro-b";
    await pointerStore.writePointer(homeDir, channel, "current", { version: "1.0.0", train: 0 });
    await pointerStore.writePointer(homeDir, channel, "next", { version: "1.5.0", train: 5 });

    const freshNext = { version: "2.0.0", train: 6 };
    let otaWrite: Promise<void> | null = null;

    // Mirrors artifact-boot.cjs's usage: the whole promote sequence runs
    // inside one mutex turn.
    const bootTurn = pointerStore.withPointerMutex(homeDir, () =>
      unprotectedPromoteSequence(homeDir, channel, () => {
        // Mirrors artifact-ota.cjs's usage: a concurrent OTA activation
        // fires its own mutex-protected write WITHOUT waiting for it here
        // — it must queue behind this still-active turn, not run inline.
        otaWrite = pointerStore.withPointerMutex(homeDir, () =>
          pointerStore.writePointer(homeDir, channel, "next", freshNext),
        );
      }));
    await bootTurn;
    expect(otaWrite).not.toBeNull();
    await otaWrite!;

    const survivedNext = await pointerStore.readPointer(homeDir, channel, "next");
    expect(survivedNext).toEqual(freshNext); // queued behind boot's turn, applied after — never lost
  });
});
