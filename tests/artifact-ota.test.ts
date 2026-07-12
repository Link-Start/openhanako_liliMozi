import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const ota = require("../desktop/src/shared/artifact-ota.cjs");
const artifactBoot = require("../desktop/src/shared/artifact-boot.cjs");
const devBypass = require("../desktop/src/shared/artifact-ota-dev-bypass.cjs");
const prodStub = require("../desktop/src/shared/artifact-ota-dev-bypass.prod-stub.cjs");
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");

const {
  checkOnce,
  downloadAndApplyArtifacts,
  fetchWithRedirects,
  fetchBuffer,
  downloadToFile,
  fetchChannelManifest,
  isShellVersionSufficient,
  isPreloadContractSatisfied,
  computeRolloutBucket,
  isInRolloutBucket,
  ensureRolloutId,
  readOtaState,
  writeOtaChannelState,
  channelManifestUrls,
  hasDevOverrideConfigured,
  readStagedTrainStatus,
  SEED_CHANNEL,
} = ota;

const PLATFORM_ARCH = "darwin-arm64";
const SHELL_VERSION = "1.0.0";
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
  delete process.env.HANA_ARTIFACT_MANIFEST;
});

function makeKeys(keyId = "ota-test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    keyset: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  };
}

/**
 * Builds a complete "next to the manifest" fixture directory: manifest.json
 * + .sig + server/renderer archives — exactly the layout the dev-bypass
 * local-path branch of `checkOnce`/`downloadAndApplyArtifacts` expects
 * (mirrors the seed/ layout artifact-boot.test.ts fixtures use).
 */
async function makeOtaFixture(root: string, keys: ReturnType<typeof makeKeys>, opts: {
  version?: string;
  train?: number;
  marker?: string;
  minShell?: string;
  rolloutPercent?: number;
  rolloutSalt?: string;
  omitRenderer?: boolean;
  omitServer?: boolean;
  corruptRendererArchive?: boolean;
  contractPreload?: number;
  contractServerProtocol?: number;
  channel?: string;
} = {}) {
  const version = opts.version ?? "2.0.0";
  const train = opts.train ?? 1;
  const marker = opts.marker ?? `ota-${train}`;
  const fixtureDir = path.join(root, `fixture-${train}-${marker}`);
  await fsp.mkdir(fixtureDir, { recursive: true });

  const serverTreeDir = path.join(root, `server-tree-${train}-${marker}`);
  await fsp.mkdir(path.join(serverTreeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(serverTreeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  const serverArchiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  const serverArchivePath = path.join(fixtureDir, serverArchiveName);
  await ustar.packTree(serverTreeDir, serverArchivePath);
  const serverSha256 = await activation.sha256File(serverArchivePath);

  const rendererTreeDir = path.join(root, `renderer-tree-${train}-${marker}`);
  await fsp.mkdir(rendererTreeDir, { recursive: true });
  await fsp.writeFile(path.join(rendererTreeDir, "index.html"), `<!doctype html><!-- ${marker} -->\n`);
  const rendererArchiveName = `renderer-${version}.tar.gz`;
  const rendererArchivePath = path.join(fixtureDir, rendererArchiveName);
  if (opts.corruptRendererArchive) {
    // Valid gzip stream, invalid ustar content beneath it: sha256 is
    // computed AFTER writing, so it's self-consistent with the manifest
    // (staging's sha256 check passes) — the failure only surfaces inside
    // activateFromArchive's ustar.extract (bad magic bytes), which is
    // exactly the "activation fails after staging succeeded" case the
    // both-or-neither rollback test needs.
    await fsp.writeFile(rendererArchivePath, zlib.gzipSync(Buffer.from("not a valid ustar archive\n")));
  } else {
    await ustar.packTree(rendererTreeDir, rendererArchivePath);
  }
  const rendererSha256 = await activation.sha256File(rendererArchivePath);

  const manifest: any = {
    schema: 1,
    train,
    channel: opts.channel ?? "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: opts.minShell ?? "0.1.0",
    contract: { preload: opts.contractPreload ?? 1, serverProtocol: opts.contractServerProtocol ?? 1 },
    urgent: false,
    rollout: { percent: opts.rolloutPercent ?? 100, salt: opts.rolloutSalt ?? "test-salt" },
    artifacts: {},
    mirrors: [],
  };
  if (!opts.omitServer) {
    manifest.artifacts.server = {
      [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName },
    };
  }
  if (!opts.omitRenderer) {
    manifest.artifacts.renderer = {
      version,
      sha256: rendererSha256,
      size: fs.statSync(rendererArchivePath).size,
      path: rendererArchiveName,
    };
  }
  if (opts.omitRenderer && opts.omitServer) {
    // schema requires at least one known kind present
    manifest.artifacts.server = {
      [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName },
    };
  }

  const manifestPath = path.join(fixtureDir, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(manifestPath, manifestBytes);
  await fsp.writeFile(`${manifestPath}.sig`, cryptoSign(null, manifestBytes, keys.privateKey));
  return { fixtureDir, manifestPath, manifest, serverSha256, rendererSha256 };
}

/**
 * Builds a schema-valid, signed manifest as bytes only — no archives, no
 * fixture directory on disk. Used by the dual-source race tests below,
 * which exercise `fetchChannelManifest`/`checkOnce` via injected
 * `fetchOnce` (never reach staging/download), so the `artifacts` entries
 * only need to be schema-shaped, not backed by real files.
 */
function buildSignedManifestBytes(keys: ReturnType<typeof makeKeys>, opts: { train: number; channel?: string; version?: string }) {
  const version = opts.version ?? "0.500.0";
  const manifest = {
    schema: 1,
    train: opts.train,
    channel: opts.channel ?? "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: "0.1.0",
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "test-salt" },
    artifacts: {
      server: { [PLATFORM_ARCH]: { version, sha256: "a".repeat(64), size: 10, path: "server.tar.gz" } },
      renderer: { version, sha256: "b".repeat(64), size: 10, path: "renderer.tar.gz" },
    },
    mirrors: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const sigBytes = cryptoSign(null, manifestBytes, keys.privateKey);
  return { manifestBytes, sigBytes, manifest };
}

// Explicitly `Promise<any>` (not generic): `ota` is an untyped CommonJS
// require of a local .cjs file with no declaration file, so a generic
// signature here infers `unknown` instead of `any` at every call site
// (TypeScript's generic inference doesn't treat a locally-required,
// undeclared module's `any` the same as a contextually-known `any`) —
// every call site would need an explicit type argument for no real
// benefit, since this helper's whole job is just "run fn with the env
// var set, then unset it" and doesn't care what fn returns.
function runWithDevOverride(manifestPath: string, fn: () => Promise<any>): Promise<any> {
  process.env.HANA_ARTIFACT_MANIFEST = manifestPath;
  return fn().finally(() => {
    delete process.env.HANA_ARTIFACT_MANIFEST;
  });
}

function stagingDirFor(homeDir: string) {
  return path.join(homeDir, "artifacts", "staging");
}

// ── low-level transport: redirect following, injectable fake transport ────

function fakeStreamResponse(statusCode: number, headers: Record<string, string>, chunks: Buffer[] = []) {
  return { statusCode, headers, bodyStream: Readable.from(chunks) };
}

/**
 * A Readable that emits `chunks` one at a time, each after a real
 * `intervalMs` delay, then ends — used to simulate a slow/trickling
 * network download with actual elapsed time (as opposed to
 * `fakeStreamResponse`'s effectively-instant `Readable.from`), so the
 * stall-window and attempt-deadline guards in `downloadToFile` have real
 * time to observe.
 */
function makeTrickleStream(chunks: Buffer[], intervalMs: number): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= chunks.length) {
        this.push(null);
        return;
      }
      const chunk = chunks[i];
      i += 1;
      setTimeout(() => this.push(chunk), intervalMs);
    },
  });
}

describe("artifact-ota: fetchWithRedirects (fake transport)", () => {
  it("follows a chain of 302 redirects to a final 200", async () => {
    const calls: string[] = [];
    const fetchOnce = async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return fakeStreamResponse(302, { location: "https://mirror.example/b" });
      if (calls.length === 2) return fakeStreamResponse(302, { location: "https://mirror.example/c" });
      return fakeStreamResponse(200, {}, [Buffer.from("ok")]);
    };
    const result = await fetchWithRedirects("https://mirror.example/a", { fetchOnce });
    expect(result.statusCode).toBe(200);
    expect(calls).toEqual([
      "https://mirror.example/a",
      "https://mirror.example/b",
      "https://mirror.example/c",
    ]);
  });

  it("rejects a redirect that downgrades to a non-https URL", async () => {
    const calls: string[] = [];
    const fetchOnce = async (url: string) => {
      calls.push(url);
      return fakeStreamResponse(302, { location: "http://insecure.example/b" });
    };
    await expect(fetchWithRedirects("https://mirror.example/a", { fetchOnce })).rejects.toThrow(/https/i);
    expect(calls.length).toBe(1); // never even tries to follow the downgraded hop
  });

  it("rejects a non-https initial URL without ever calling the transport", async () => {
    let called = false;
    const fetchOnce = async () => {
      called = true;
      return fakeStreamResponse(200, {}, []);
    };
    await expect(fetchWithRedirects("http://insecure.example/a", { fetchOnce })).rejects.toThrow(/https/i);
    expect(called).toBe(false);
  });

  it("rejects after exceeding the redirect hop cap", async () => {
    let calls = 0;
    const fetchOnce = async () => {
      calls += 1;
      return fakeStreamResponse(302, { location: `https://mirror.example/hop-${calls}` });
    };
    await expect(
      fetchWithRedirects("https://mirror.example/a", { fetchOnce, maxRedirects: 3 }),
    ).rejects.toThrow(/too many redirects/i);
    expect(calls).toBe(4); // hops 0,1,2,3 attempted, the 4th response is the one that trips the cap
  });
});

describe("artifact-ota: fetchBuffer", () => {
  it("surfaces a 304 as a null-body result", async () => {
    const fetchOnce = async () => fakeStreamResponse(304, {});
    const result = await fetchBuffer("https://mirror.example/manifest.json", { fetchOnce });
    expect(result.statusCode).toBe(304);
    expect(result.body).toBeNull();
  });

  it("rejects a non-2xx/304 status", async () => {
    const fetchOnce = async () => fakeStreamResponse(404, {});
    await expect(fetchBuffer("https://mirror.example/manifest.json", { fetchOnce })).rejects.toThrow(/404/);
  });

  it("returns the buffered body on 200", async () => {
    const fetchOnce = async () => fakeStreamResponse(200, { etag: '"abc"' }, [Buffer.from("hello "), Buffer.from("world")]);
    const result = await fetchBuffer("https://mirror.example/manifest.json", { fetchOnce });
    expect(result.body?.toString("utf8")).toBe("hello world");
    expect(result.headers.etag).toBe('"abc"');
  });

  it("enforces maxBytes and aborts before buffering the whole body", async () => {
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.alloc(1000, 1)]);
    await expect(fetchBuffer("https://mirror.example/manifest.json", { fetchOnce, maxBytes: 100 })).rejects.toThrow(
      /exceeded 100 bytes/,
    );
  });
});

describe("artifact-ota: downloadToFile", () => {
  it("streams the body to disk", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "out", "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.from("payload-bytes")]);
    const result = await downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce });
    expect(result.statusCode).toBe(200);
    expect(fs.readFileSync(destPath, "utf8")).toBe("payload-bytes");
  });

  it("reports cumulative received bytes via onProgress as chunks arrive", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.alloc(5), Buffer.alloc(7)]);
    const received: number[] = [];
    await downloadToFile("https://mirror.example/archive.tar.gz", destPath, {
      fetchOnce,
      onProgress: (n: number) => received.push(n),
    });
    expect(received).toEqual([5, 12]);
  });

  it("enforces maxBytes and removes the partial file on overflow", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.alloc(1000, 7)]);
    await expect(
      downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce, maxBytes: 100 }),
    ).rejects.toThrow(/exceeded 100 bytes/);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("rejects a non-2xx status without writing a file", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(500, {});
    await expect(downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce })).rejects.toThrow(/500/);
    expect(fs.existsSync(destPath)).toBe(false);
  });
});

describe("artifact-ota: downloadToFile stall/deadline guards (trickle-attack mitigation)", () => {
  it("aborts a trickling download that never clears the rolling stall window, and cleans up the partial file", async () => {
    const root = makeTempDir("hana-ota-dl-stall-");
    const destPath = path.join(root, "archive.tar.gz");
    // 5 chunks of 10 bytes each, one every 200ms — far slower than the 50ms
    // stall window / 1000-byte minimum below, so the rolling-progress guard
    // must fire long before the stream would ever finish naturally.
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(10, 1));
    const fetchOnce = async () => ({ statusCode: 200, headers: {}, bodyStream: makeTrickleStream(chunks, 200) });

    await expect(
      downloadToFile("https://mirror.example/archive.tar.gz", destPath, {
        fetchOnce,
        stallWindowMs: 50,
        stallMinBytes: 1000,
      }),
    ).rejects.toThrow(/stalled/);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("does not abort a healthy trickling download that clears the stall window every round", async () => {
    const root = makeTempDir("hana-ota-dl-stall-ok-");
    const destPath = path.join(root, "archive.tar.gz");
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(50, 2));
    const fetchOnce = async () => ({ statusCode: 200, headers: {}, bodyStream: makeTrickleStream(chunks, 5) });

    const result = await downloadToFile("https://mirror.example/archive.tar.gz", destPath, {
      fetchOnce,
      stallWindowMs: 50,
      stallMinBytes: 10,
    });
    expect(result.bytesWritten).toBe(250);
    expect(fs.readFileSync(destPath).length).toBe(250);
  });

  it("aborts a download that exceeds the hard per-attempt deadline even with otherwise-healthy progress", async () => {
    const root = makeTempDir("hana-ota-dl-deadline-");
    const destPath = path.join(root, "archive.tar.gz");
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(50, 3));
    const fetchOnce = async () => ({ statusCode: 200, headers: {}, bodyStream: makeTrickleStream(chunks, 20) });

    await expect(
      downloadToFile("https://mirror.example/archive.tar.gz", destPath, {
        fetchOnce,
        stallWindowMs: 1000, // generous — never the guard that fires here
        stallMinBytes: 1,
        attemptDeadlineMs: 40, // natural duration is ~200ms; deadline must win
      }),
    ).rejects.toThrow(/deadline/);
    expect(fs.existsSync(destPath)).toBe(false);
  });
});

describe("artifact-ota: channelManifestUrls", () => {
  it("returns [origin(GitHub), mirror(AtomGit)] — a role label, not a priority order (both are fetched in parallel)", () => {
    const urls = channelManifestUrls("stable");
    expect(urls[0]).toBe("https://github.com/liliMozi/openhanako/releases/download/channels/stable.json");
    expect(urls[1]).toBe("https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/channels/stable.json");
  });
});

// ── dual-source manifest fetch: both channel-manifest sources are raced in
//    parallel, verified independently, and the higher-train side wins (tie
//    goes to the origin) — see artifact-ota.cjs's file header "dual-source
//    manifest fetch" note for the full design rationale ─────────────────

function installTwoSourceFetch(
  originUrl: string,
  mirrorUrl: string,
  origin: { manifestBytes: Buffer; sigBytes: Buffer } | "error" | "not-modified" | null,
  mirror: { manifestBytes: Buffer; sigBytes: Buffer } | "error" | "not-modified" | null,
) {
  return async (url: string) => {
    const respond = (side: typeof origin, base: string, label: string) => {
      if (side === "error" || side === null) throw new Error(`${label} unreachable`);
      if (side === "not-modified") return fakeStreamResponse(304, {});
      if (url === base) return fakeStreamResponse(200, {}, [side.manifestBytes]);
      if (url === `${base}.sig`) return fakeStreamResponse(200, {}, [side.sigBytes]);
      throw new Error(`unexpected url ${url}`);
    };
    if (url === originUrl || url === `${originUrl}.sig`) return respond(origin, originUrl, "origin");
    if (url === mirrorUrl || url === `${mirrorUrl}.sig`) return respond(mirror, mirrorUrl, "mirror");
    throw new Error(`unexpected url ${url}`);
  };
}

describe("artifact-ota: fetchChannelManifest (dual-source parallel race)", () => {
  it("keeps the origin's manifest when its train is higher than the mirror's (mirror lagging behind origin)", async () => {
    const keys = makeKeys();
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const origin = buildSignedManifestBytes(keys, { train: 4, version: "0.402.0" });
    const mirror = buildSignedManifestBytes(keys, { train: 3, version: "0.401.0" });
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, origin, mirror);

    const result = await fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} });

    expect(result.notModified).toBeUndefined();
    expect(result.manifest.train).toBe(4);
    expect(result.sourceKind).toBe("origin");
    expect(result.originUnreachable).toBe(false);
  });

  it("keeps the mirror's manifest when its train is strictly higher than the origin's (mirror ahead, reverse case)", async () => {
    const keys = makeKeys();
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const origin = buildSignedManifestBytes(keys, { train: 3, version: "0.401.0" });
    const mirror = buildSignedManifestBytes(keys, { train: 5, version: "0.403.0" });
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, origin, mirror);

    const result = await fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} });

    expect(result.manifest.train).toBe(5);
    expect(result.sourceKind).toBe("mirror");
    // Origin DID participate (it verified fine, it just lost the train
    // comparison) — originUnreachable must stay false; it only reflects
    // whether origin contributed a candidate, not whether it won.
    expect(result.originUnreachable).toBe(false);
  });

  it("breaks an exact train-number tie in favor of the origin", async () => {
    const keys = makeKeys();
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const origin = buildSignedManifestBytes(keys, { train: 4, version: "0.402.0" });
    const mirror = buildSignedManifestBytes(keys, { train: 4, version: "0.402.0" });
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, origin, mirror);

    const result = await fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} });

    expect(result.sourceKind).toBe("origin");
  });

  it("sets originUnreachable and resolves from the mirror alone when the origin fetch fails outright", async () => {
    const root = makeTempDir("hana-ota-dual-source-");
    const keys = makeKeys();
    const homeDir = path.join(root, "home");
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const mirror = buildSignedManifestBytes(keys, { train: 9, version: "0.409.0" });
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, "error", mirror);

    const result = await checkOnce({
      homeDir,
      keyset: keys.keyset,
      currentShellVersion: SHELL_VERSION,
      platformArch: PLATFORM_ARCH,
      channel: "stable",
      fetchOnce,
      log: () => {},
    });

    expect(result.outcome).toBe("available");
    expect(result.train).toBe(9);

    // State persisted and readable back through both surfaces the settings
    // page consumes.
    const state = (await readOtaState(homeDir)).stable;
    expect(state.manifestSource).toBe("mirror");
    expect(state.originUnreachable).toBe(true);
    expect(state.manifestReleasedAt).toBe("2026-07-11T00:00:00.000Z");

    const status = await readStagedTrainStatus(homeDir, { channel: "stable" });
    expect(status.manifestSource).toBe("mirror");
    expect(status.originUnreachable).toBe(true);
    expect(status.manifestReleasedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("excludes a candidate whose signature fails verification without poisoning the other side's valid candidate", async () => {
    const keys = makeKeys();
    const otherKeys = makeKeys("some-other-key-not-in-keyset");
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    // Origin is signed with a key that ISN'T in the keyset passed to
    // fetchChannelManifest below — verification must fail for it, exactly
    // like a tampered signature or a compromised source would.
    const origin = buildSignedManifestBytes(otherKeys, { train: 10, version: "0.410.0" });
    const mirror = buildSignedManifestBytes(keys, { train: 6, version: "0.406.0" });
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, origin, mirror);

    const result = await fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} });

    // The mirror's valid, lower-train candidate must still win — the
    // origin's invalid signature excludes it entirely rather than being
    // preferred by the tie/train-number logic or blocking the round.
    expect(result.manifest.train).toBe(6);
    expect(result.sourceKind).toBe("mirror");
    expect(result.originUnreachable).toBe(true);
  });

  it("errors when both sources fail (neither fetch succeeds nor answers 304)", async () => {
    const keys = makeKeys();
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, "error", "error");

    await expect(
      fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} }),
    ).rejects.toThrow(/all channel manifest sources failed/i);
  });

  it("reports not-modified when both sources answer 304", async () => {
    const keys = makeKeys();
    const [originUrl, mirrorUrl] = channelManifestUrls("stable");
    const fetchOnce = installTwoSourceFetch(originUrl, mirrorUrl, "not-modified", "not-modified");

    const result = await fetchChannelManifest({ channel: "stable", keyset: keys.keyset, fetchOnce, log: () => {} });

    expect(result.notModified).toBe(true);
  });
});

describe("artifact-ota: isShellVersionSufficient (minShell gate)", () => {
  it("passes when the shell version equals minShell", () => {
    expect(isShellVersionSufficient("1.2.3", "1.2.3")).toBe(true);
  });
  it("passes when the shell version exceeds minShell", () => {
    expect(isShellVersionSufficient("2.0.0", "1.2.3")).toBe(true);
    expect(isShellVersionSufficient("1.3.0", "1.2.9")).toBe(true);
  });
  it("blocks when the shell version is below minShell", () => {
    expect(isShellVersionSufficient("1.2.2", "1.2.3")).toBe(false);
    expect(isShellVersionSufficient("0.9.9", "1.0.0")).toBe(false);
  });
  it("blocks (conservative default) when either version is unparseable", () => {
    expect(isShellVersionSufficient("not-a-version", "1.0.0")).toBe(false);
    expect(isShellVersionSufficient("1.0.0", "not-a-version")).toBe(false);
  });
});

describe("artifact-ota: isPreloadContractSatisfied (preload contract gate)", () => {
  it("passes when the manifest's required preload version equals the shell's supported version", () => {
    expect(isPreloadContractSatisfied(1, 1)).toBe(true);
  });
  it("passes when the shell supports a newer preload version than the manifest requires", () => {
    expect(isPreloadContractSatisfied(1, 2)).toBe(true);
  });
  it("blocks when the manifest requires a preload version the shell does not support yet", () => {
    expect(isPreloadContractSatisfied(2, 1)).toBe(false);
  });
});

describe("artifact-ota: rollout bucketing", () => {
  it("is deterministic for a fixed rolloutId + salt", () => {
    const a = computeRolloutBucket("fixed-uuid", "salt-1");
    const b = computeRolloutBucket("fixed-uuid", "salt-1");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });
  it("changes with a different salt (not a constant)", () => {
    const a = computeRolloutBucket("fixed-uuid", "salt-1");
    const b = computeRolloutBucket("fixed-uuid", "salt-2");
    // Not strictly guaranteed to differ for every pair, but true for this
    // fixed pair — pinning the exact expectation catches accidental
    // algorithm changes.
    expect(a === b).toBe(false);
  });
  it("percent=100 always includes, percent=0 always excludes, regardless of bucket", () => {
    expect(isInRolloutBucket({ rolloutId: "any", salt: "s", percent: 100 })).toBe(true);
    expect(isInRolloutBucket({ rolloutId: "any", salt: "s", percent: 0 })).toBe(false);
  });
});

describe("artifact-ota: ensureRolloutId", () => {
  it("generates and persists a UUID on first use, returns the same one afterward", async () => {
    const root = makeTempDir("hana-ota-rollout-");
    const homeDir = path.join(root, "home");
    const first = await ensureRolloutId(homeDir);
    const second = await ensureRolloutId(homeDir);
    expect(first).toBe(second);
    expect(fs.existsSync(path.join(homeDir, "artifacts", "rollout-id"))).toBe(true);
  });
});

describe("artifact-ota: ota-state.json bookkeeping", () => {
  it("round-trips a channel state patch and merges subsequent patches", async () => {
    const root = makeTempDir("hana-ota-state-");
    const homeDir = path.join(root, "home");
    expect(await readOtaState(homeDir)).toEqual({});
    await writeOtaChannelState(homeDir, "stable", { etag: "abc", lastError: null });
    await writeOtaChannelState(homeDir, "stable", { lastCheckedAt: "2026-07-11T00:00:00.000Z" });
    const state = await readOtaState(homeDir);
    expect(state.stable).toEqual({ etag: "abc", lastError: null, lastCheckedAt: "2026-07-11T00:00:00.000Z" });
  });
});

describe("artifact-ota: dev-bypass module (real + prod stub)", () => {
  afterEach(() => {
    delete process.env.HANA_ARTIFACT_MANIFEST;
  });
  it("real module reads HANA_ARTIFACT_MANIFEST", () => {
    expect(devBypass.hasDevOverride()).toBe(false);
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(devBypass.hasDevOverride()).toBe(true);
    expect(devBypass.resolveDevManifestOverride()).toBe("/tmp/whatever.json");
  });
  it("production stub always returns null/false, ignoring the env var", () => {
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(prodStub.hasDevOverride()).toBe(false);
    expect(prodStub.resolveDevManifestOverride()).toBeNull();
  });
  it("hasDevOverrideConfigured (as re-exported by artifact-ota.cjs) tracks the real module", () => {
    expect(hasDevOverrideConfigured()).toBe(false);
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(hasDevOverrideConfigured()).toBe(true);
  });
});

// ── checkOnce: never writes an archive, never extracts, never writes a
//    pointer — only ota-state.json bookkeeping and the rollout-id file ────

describe("artifact-ota: checkOnce (gates, never downloads)", () => {
  it("reports 'available' and records it in ota-state when real new content exists, downloading nothing", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 7, version: "0.500.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("available");
    expect(result.train).toBe(7);
    expect(result.version).toBe("0.500.0");

    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toMatchObject({ train: 7, version: "0.500.0" });
    expect(typeof state.available.serverSha256).toBe("string");
    expect(typeof state.available.rendererSha256).toBe("string");
    expect(state.available.sizes.server).toBeGreaterThan(0);
    expect(state.available.sizes.renderer).toBeGreaterThan(0);
    expect(state.minShellBlocked).toBe(false);

    // Zero download calls: checkOnce structurally never creates a staging
    // directory or writes a next pointer.
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("reports up-to-date (not an error) when the train is not newer than the currently activated train", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3 });
    const homeDir = path.join(root, "home");
    // Pre-seed a `current` pointer at train 5 — the fixture's train 3 is
    // stale, but that's normal (already caught up), not an error.
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", { train: 5, kind: "server" });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("up-to-date");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
  });

  it("reports up-to-date when the manifest's content hashes already match `current`, even though the train advanced", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath, serverSha256, rendererSha256 } = await makeOtaFixture(root, keys, { train: 2, version: "2.0.0" });
    const homeDir = path.join(root, "home");
    // `current` is at a lower train number but already carries the exact
    // bytes this manifest announces — a re-cut release under a new train
    // number, not a real content change.
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", { train: 1, kind: "server", sha256: serverSha256 });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", { train: 1, kind: "renderer", sha256: rendererSha256 });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("up-to-date");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("reports up-to-date when the current pointers' version matches the manifest version even though sha256 differs (same version, different bytes across build runners)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.389.0" });
    const homeDir = path.join(root, "home");
    // `current` is several trains behind and carries different bytes than
    // this manifest's entries (a different CI runner packed this box), but
    // it's already at the exact same product version. A version directory
    // is named after the version number, so a same-version-different-bytes
    // train can never be applied anyway — it must not be surfaced as "a
    // new version is available".
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.389.0",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.389.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("up-to-date");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
    expect(state.lastError).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("still reports 'available' when the version actually changed, even with a stale current pointer present (regression guard for the same-version reconciliation gate)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.390.0" });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.389.0",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.389.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("available");
    expect(result.version).toBe("0.390.0");
  });

  it("reports up-to-date when the manifest's version is OLDER than the currently activated version, even on a newer train (a downgrade is never surfaced as an update)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.389.0" });
    const homeDir = path.join(root, "home");
    // The install is at a HIGHER content version than the shelf (dev build,
    // or a fresh installer released ahead of its train). The shelf's train
    // number is newer, but applying it would move the content backward —
    // data migrations only run forward, so this must read as "already up
    // to date", never as "a new version is available".
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.446.20",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.446.20",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("up-to-date");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
    expect(state.lastError).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("still reports 'available' when the manifest's version is higher than the current pointers' version (the downgrade gate must not fire on a real upgrade)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.101.0" });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.100.0",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.100.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("available");
    expect(result.version).toBe("0.101.0");
  });

  it("reports up-to-date when only ONE kind's pointer is ahead of the manifest version (a half-behind train is conservatively not an update)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.400.0" });
    const homeDir = path.join(root, "home");
    // Server pointer is AHEAD of the manifest (0.446.20 > 0.400.0), the
    // renderer pointer is behind it (0.389.0 < 0.400.0). Applying this
    // train would downgrade the server kind — one kind moving backward is
    // enough to refuse the whole train (both kinds always ship together).
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.446.20",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.389.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("up-to-date");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
  });

  it("compares versions numerically per segment, not as strings (0.99.0 is BEHIND 0.100.0 even though '0.99.0' > '0.100.0' lexicographically)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.99.0" });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.100.0",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.100.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    // A lexicographic comparison would call 0.99.0 "newer" than 0.100.0 and
    // surface the downgrade as an update; numeric comparison must not.
    expect(result.outcome).toBe("up-to-date");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
  });

  it("skips (does not record available) when the shell is below minShell, but still records the available descriptor with minShellBlocked", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, minShell: "99.0.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("minshell-blocked");
    expect(result.minShellBlocked).toBe(true);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);

    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.minShellBlocked).toBe(true);
    expect(state.blockedReason).toBe("minShell");
    expect(state.available).not.toBeNull();
    expect(state.available.train).toBe(1);
  });

  it("blocks via the same minshell-blocked path when the manifest requires a newer preload contract than this shell supports", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, contractPreload: 2 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("minshell-blocked");
    expect(result.minShellBlocked).toBe(true);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);

    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.minShellBlocked).toBe(true);
    expect(state.blockedReason).toBe("preloadContract");
    expect(state.available).not.toBeNull();
    expect(state.available.train).toBe(1);
  });

  it("does not block on the preload contract when the manifest requires exactly the version this shell supports (regression guard)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, contractPreload: 1 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("available");
    expect(result.minShellBlocked).toBe(false);
  });

  it("excludes via rollout percent 0, without recording an available update", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, rolloutPercent: 0 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("rollout-excluded");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
  });

  it("short-circuits a quarantined train, without recording an available update", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 7 });
    const homeDir = path.join(root, "home");
    await pointerStore.appendQuarantine(homeDir, { channel: SEED_CHANNEL, train: 7, reason: "test" });

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("quarantined");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
  });

  it("hard-errors when the manifest is missing the renderer kind", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, omitRenderer: true });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/renderer/i);
  });

  it("rejects a tampered manifest signature", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1 });
    const sig = fs.readFileSync(`${manifestPath}.sig`);
    sig[0] ^= 0xff;
    fs.writeFileSync(`${manifestPath}.sig`, sig);
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/signature/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });
});

// ── channel namespace assertion: a validly-signed manifest for the WRONG
//    channel (e.g. a beta manifest served back from the stable URL) must
//    never be silently accepted onto this channel's pointer namespace ────

describe("artifact-ota: checkOnce (channel assertion)", () => {
  it("rejects (outcome 'error') when a stable request receives a validly-signed manifest that declares channel 'beta'", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, channel: "beta" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, channel: "stable", log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/stable/);
    expect(result.error).toMatch(/beta/);
    expect(await pointerStore.readPointer(homeDir, "stable", "next")).toBeNull();
    const state = (await readOtaState(homeDir)).stable;
    expect(state.lastError).toMatch(/stable/);
    expect(state.lastError).toMatch(/beta/);
  });

  it("still checks out normally (regression) when the manifest's channel matches the requested channel", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, channel: "stable", version: "0.500.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, channel: "stable", log: () => {} }),
    );

    expect(result.outcome).toBe("available");
    expect(result.version).toBe("0.500.0");
  });
});

describe("artifact-ota: downloadAndApplyArtifacts (channel assertion)", () => {
  it("rejects when a stable apply-now receives a validly-signed manifest that declares channel 'beta'", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, channel: "beta" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, channel: "stable", log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stable/);
    expect(result.error).toMatch(/beta/);
    expect(await pointerStore.readPointer(homeDir, "stable", "next")).toBeNull();
  });
});

describe("artifact-ota: checkOnce (ETag / not-modified semantics, mutation-check target)", () => {
  it("a 304 leaves a previously recorded `available` and `lastError` untouched, only lastCheckedAt advances", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const homeDir = path.join(root, "home");
    const urls = channelManifestUrls(SEED_CHANNEL);
    const seededAvailable = {
      train: 5,
      version: "5.0.0",
      serverSha256: "a".repeat(64),
      rendererSha256: "b".repeat(64),
      sizes: { server: 1, renderer: 1 },
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeOtaChannelState(homeDir, SEED_CHANNEL, {
      etag: '"etag-1"',
      lastManifestUrl: urls[0],
      lastError: "previous failure",
      available: seededAvailable,
      minShellBlocked: false,
    });

    const fetchOnce = async () => fakeStreamResponse(304, {});
    const result = await checkOnce({
      homeDir,
      keyset: keys.keyset,
      currentShellVersion: SHELL_VERSION,
      platformArch: PLATFORM_ARCH,
      channel: SEED_CHANNEL,
      fetchOnce,
      log: () => {},
    });

    expect(result.outcome).toBe("not-modified");
    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    // THE critical assertion this test exists for: "no news" must not be
    // mistaken for "you are up to date" — both fields from the last real
    // check must survive a 304 byte-for-byte.
    expect(state.available).toEqual(seededAvailable);
    expect(state.lastError).toBe("previous failure");
  });

  it("keeps lastError from a failed check through a later 304 (a quiet poll doesn't mean the earlier failure resolved)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1 });
    const sig = fs.readFileSync(`${manifestPath}.sig`);
    sig[0] ^= 0xff;
    fs.writeFileSync(`${manifestPath}.sig`, sig);
    const homeDir = path.join(root, "home");

    const firstResult = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );
    expect(firstResult.outcome).toBe("error");
    const stateAfterError = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(stateAfterError.lastError).toMatch(/signature/i);

    const fetchOnce = async () => fakeStreamResponse(304, {});
    const secondResult = await checkOnce({
      homeDir,
      keyset: keys.keyset,
      currentShellVersion: SHELL_VERSION,
      platformArch: PLATFORM_ARCH,
      channel: SEED_CHANNEL,
      fetchOnce,
      log: () => {},
    });

    expect(secondResult.outcome).toBe("not-modified");
    const stateAfter304 = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(stateAfter304.lastError).toMatch(/signature/i);
  });
});

// ── downloadAndApplyArtifacts: the only function allowed to write an
//    archive to disk or activate anything — only ever called because a
//    user clicked something ──────────────────────────────────────────────

describe("artifact-ota: downloadAndApplyArtifacts", () => {
  it("stages both archives, activates them in order with phase-ordered progress, and clears available/lastError", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, version: "2.0.0" });
    const homeDir = path.join(root, "home");
    await writeOtaChannelState(homeDir, SEED_CHANNEL, {
      available: { train: 1, version: "2.0.0" },
      lastError: "stale error from an earlier failed check",
    });

    const progressEvents: Array<{ phase: string; kind: string }> = [];
    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({
        homeDir,
        keyset: keys.keyset,
        currentShellVersion: SHELL_VERSION,
        platformArch: PLATFORM_ARCH,
        onProgress: (e: { phase: string; kind: string }) => progressEvents.push({ phase: e.phase, kind: e.kind }),
        log: () => {},
      }),
    );

    expect(result).toEqual({ ok: true, train: 1, version: "2.0.0" });

    const serverNext = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next");
    expect(serverNext).not.toBeNull();
    expect(serverNext.kind).toBe("server");
    expect(fs.existsSync(path.join(serverNext.versionDir, "bundle", "index.js"))).toBe(true);

    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    const rendererNext = await pointerStore.readPointer(homeDir, rendererChannel, "next");
    expect(rendererNext).not.toBeNull();
    expect(rendererNext.kind).toBe("renderer");
    expect(fs.existsSync(path.join(rendererNext.versionDir, "index.html"))).toBe(true);

    // Phases fire in a fixed order: download+verify server, then
    // download+verify renderer, then activate server, then activate
    // renderer.
    const phaseKindSequence = progressEvents.map((e) => `${e.phase}:${e.kind}`);
    expect(phaseKindSequence).toEqual([
      "downloading:server",
      "verifying:server",
      "downloading:renderer",
      "verifying:renderer",
      "activating:server",
      "activating:renderer",
    ]);

    const state = (await readOtaState(homeDir))[SEED_CHANNEL];
    expect(state.available).toBeNull();
    expect(state.lastError).toBeNull();

    // Staging is cleaned up after a successful run.
    const leftovers = fs.existsSync(stagingDirFor(homeDir)) ? fs.readdirSync(stagingDirFor(homeDir)) : [];
    expect(leftovers).toEqual([]);
  });

  it("both-or-neither: rolls back the server next pointer when renderer activation fails after staging succeeded", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, corruptRendererArchive: true });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/renderer activation failed/i);
    // The critical assertion: server's next pointer must NOT survive a
    // renderer activation failure, even though activateFromArchive(server)
    // itself succeeded and wrote it moments earlier.
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    expect(await pointerStore.readPointer(homeDir, rendererChannel, "next")).toBeNull();
  });

  it("fails with zero activation when a gate rejects at click time (the shelf moved since the last check)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, rolloutPercent: 0 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rollout-excluded/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("rejects with zero activation when the manifest requires a newer preload contract than this shell supports", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, contractPreload: 2 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    // Message must be attributable: both the manifest's required version and
    // this shell's supported version, so a support screenshot is self-explanatory.
    expect(result.error).toMatch(/preload/i);
    expect(result.error).toContain("2");
    expect(result.error).toContain("1");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("fails when the train is not newer than the currently activated train (nothing to apply)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3 });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", { train: 5, kind: "server" });

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not newer/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("fails without downloading any artifact archives when the current pointers' version matches the manifest version even though sha256 differs (same version, different bytes across build runners)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.389.0" });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.389.0",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.389.0",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/0\.389\.0/);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(await pointerStore.readPointer(homeDir, rendererChannel, "next")).toBeNull();
    // Never even reaches staging: the archives are never downloaded when
    // this gate rejects before `acquireLock`.
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("fails without downloading any artifact archives when the manifest's version is OLDER than the currently activated version (content version never goes backward)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3, version: "0.389.0" });
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", {
      train: 0,
      kind: "server",
      version: "0.446.20",
      sha256: "a".repeat(64),
    });
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    await pointerStore.writePointer(homeDir, rendererChannel, "current", {
      train: 0,
      kind: "renderer",
      version: "0.446.20",
      sha256: "b".repeat(64),
    });

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    // Message must be attributable: both the shelf's version and this
    // install's activated version, so a support screenshot is self-explanatory.
    expect(result.error).toContain("0.389.0");
    expect(result.error).toContain("0.446.20");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    expect(await pointerStore.readPointer(homeDir, rendererChannel, "next")).toBeNull();
    // Never even reaches staging: the archives are never downloaded when
    // this gate rejects before `acquireLock`.
    expect(fs.existsSync(stagingDirFor(homeDir))).toBe(false);
  });

  it("fails and activates nothing when a staged download's sha256 doesn't match the manifest", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath, fixtureDir } = await makeOtaFixture(root, keys, { train: 1, version: "3.0.0" });
    const serverArchivePath = path.join(fixtureDir, `server-3.0.0-${PLATFORM_ARCH}.tar.gz`);
    const bytes = fs.readFileSync(serverArchivePath);
    bytes[bytes.length - 1] ^= 0xff; // corrupt the bytes AFTER the manifest's sha256 was computed from the original
    fs.writeFileSync(serverArchivePath, bytes);
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sha256 mismatch/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("fails when another instance holds the artifacts lock", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1 });
    const homeDir = path.join(root, "home");
    const lock = await pointerStore.acquireLock(homeDir);
    expect(lock).not.toBeNull();

    try {
      const result = await runWithDevOverride(manifestPath, () =>
        downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/lock/i);
      expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    } finally {
      await lock!.release();
    }
  });

  it("fails when the manifest is missing the renderer kind", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, omitRenderer: true });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/renderer/i);
  });
});

describe("artifact-ota: bothNextPointersReady (apply-now precondition guard, mutation-check target)", () => {
  const { bothNextPointersReady } = ota;

  it("is false when either pointer is missing", () => {
    expect(bothNextPointersReady({ serverNext: null, rendererNext: { train: 1 } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: 1 }, rendererNext: null })).toBe(false);
    expect(bothNextPointersReady({ serverNext: null, rendererNext: null })).toBe(false);
  });

  it("is false when either train is not an integer", () => {
    expect(bothNextPointersReady({ serverNext: { train: "1" }, rendererNext: { train: 1 } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: 1 }, rendererNext: { train: undefined } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: NaN }, rendererNext: { train: 1 } })).toBe(false);
  });

  it("is false when the two trains disagree (partial/torn staging)", () => {
    expect(bothNextPointersReady({ serverNext: { train: 2 }, rendererNext: { train: 1 } })).toBe(false);
  });

  it("is true only when both pointers exist and agree on the same train", () => {
    expect(bothNextPointersReady({ serverNext: { train: 5 }, rendererNext: { train: 5 } })).toBe(true);
  });
});

describe("artifact-ota: resolveStagedTrainStatus", () => {
  const { resolveStagedTrainStatus } = ota;

  it("reports not-staged with null fields when pointers disagree", () => {
    expect(resolveStagedTrainStatus({ serverNext: null, rendererNext: null })).toEqual({
      staged: false,
      train: null,
      version: null,
    });
  });

  it("reports staged with the train number and renderer's product version", () => {
    expect(resolveStagedTrainStatus({
      serverNext: { train: 3, version: "0.400.0" },
      rendererNext: { train: 3, version: "0.400.0" },
    })).toEqual({ staged: true, train: 3, version: "0.400.0" });
  });

  it("falls back to the server version if the renderer pointer somehow lacks one", () => {
    expect(resolveStagedTrainStatus({
      serverNext: { train: 3, version: "0.400.0" },
      rendererNext: { train: 3 },
    })).toEqual({ staged: true, train: 3, version: "0.400.0" });
  });
});

describe("artifact-ota: readStagedTrainStatus (filesystem integration)", () => {
  it("reports not staged when no next pointers exist", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const homeDir = path.join(root, "home");
    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status).toEqual({
      staged: false,
      train: null,
      version: null,
      minShellBlocked: false,
      available: null,
      lastError: null,
      lastCheckedAt: null,
      manifestSource: null,
      manifestReleasedAt: null,
      originUnreachable: false,
    });
  });

  it("reports staged after downloadAndApplyArtifacts writes both next pointers", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 7, version: "0.500.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      downloadAndApplyArtifacts({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );
    expect(result.ok).toBe(true);

    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status.staged).toBe(true);
    expect(status.train).toBe(7);
    expect(status.version).toBe("0.500.0");
    expect(status.available).toBeNull();
  });

  it("reports minShellBlocked with the available descriptor after a minShell-gated checkOnce, without staging anything", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, minShell: "99.0.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );
    expect(result.outcome).toBe("minshell-blocked");

    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status.staged).toBe(false);
    expect(status.minShellBlocked).toBe(true);
    expect(status.available).not.toBeNull();
    expect(status.available.train).toBe(1);
  });

  it("tolerates a pre-upgrade ota-state.json with no available/minShellBlocked fields, falling back to lastSkipReason", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const homeDir = path.join(root, "home");
    // Simulate a state file written by a shell version that predates this
    // change: only the legacy fields exist.
    await pointerStore.atomicWriteJson(path.join(homeDir, "artifacts", "ota-state.json"), {
      [SEED_CHANNEL]: {
        etag: '"old-etag"',
        lastCheckedAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
        lastSkipReason: "minShell 99.0.0 > shell 1.0.0",
      },
    });

    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status).toEqual({
      staged: false,
      train: null,
      version: null,
      minShellBlocked: true,
      available: null,
      lastError: null,
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      manifestSource: null,
      manifestReleasedAt: null,
      originUnreachable: false,
    });
  });
});
