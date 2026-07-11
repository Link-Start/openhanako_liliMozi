#!/usr/bin/env node
/**
 * scripts/publish-train.mjs — publishes one channel's hot-update train.
 *
 * Takes the platform archives already sitting on an installer release
 * (`vX.Y.Z`, built by .github/workflows/build.yml) and turns them into a
 * signed train manifest for ONE update channel:
 *   1. Downloads that tag's `server-*.tar.gz` + `renderer-*.tar.gz` assets
 *      and hashes them.
 *   2. Reads the channel's current pointer (`channels` release,
 *      `<channel>.json`) to find the last published train number; the next
 *      train is that value + 1, or 1 if the channel has never published.
 *   3. Builds a schema-1 manifest for that train via `buildSeedManifest`
 *      (scripts/build-server-artifact.mjs) — the SAME function the local/CI
 *      seed build uses — called once per platform-arch and merged, so
 *      `minShell`/`contract`/schema come from that one source instead of
 *      being re-invented here.
 *   4. Signs it and either creates a new `train-<N>` release (archives +
 *      train.json + train.json.sig) or, if that release already exists
 *      with byte-identical artifacts (see "resumable publish" below),
 *      reuses it without re-uploading.
 *   5. Publishes `<channel>.json` + `<channel>.json.sig` to the `channels`
 *      release — the two static files installed clients actually poll
 *      (desktop/src/shared/artifact-ota.cjs's `channelManifestUrls`).
 *
 * Channel independence: stable and beta each keep their own train counter,
 * read from their own `<channel>.json`. A normal `vX.Y.Z` tag publishes
 * both (see the `publish-train` job in build.yml) from the SAME archives,
 * so the two channels usually land on the same train number, but the
 * counters are tracked independently and are allowed to drift (e.g. after
 * a channel-scoped manual run via the escape-hatch workflow).
 *
 * Resumable publish: this script may be re-run for a tag/channel pair that
 * already succeeded, or that failed partway through (the CI job that
 * calls it is not transactional). After computing the target train N, if a
 * `train-<N>` release already exists, its train.json is downloaded and
 * compared against this run's freshly-computed artifacts (version + sha256
 * per archive — NOT full-manifest equality, since releasedAt/rollout.salt/
 * channel are expected to differ run-to-run and channel-to-channel). An
 * exact artifact match means train N was already built by an earlier
 * (possibly interrupted, possibly other-channel) run and it is safe to
 * skip re-uploading the boxes; a mismatch is a real conflict and is a hard
 * error — never silently overwritten. Either way, THIS channel's pointer
 * (`<channel>.json`) is always its own freshly signed manifest carrying
 * this channel's name, train number, releasedAt and rollout salt — it is
 * never a byte-copy of another channel's train.json, so `beta.json` always
 * reads `channel: "beta"` even when it happens to share a train-N box
 * release with stable.
 *
 * Anti-rollback: train numbers only go up, per channel, forever. There is
 * no "delete a train" or "go back to N-1" operation. A bad release is
 * fixed by publishing a NEW, higher-numbered train that points at good
 * artifacts — never by mutating or removing a past one.
 *
 * Usage:
 *   node scripts/publish-train.mjs --tag vX.Y.Z --channel stable|beta [--dry-run]
 *
 * Env:
 *   GH_TOKEN            required (gh CLI auth)
 *   HANA_SIGN_KEY       required for a real (non-dry-run) publish — PKCS8 PEM
 *                        private key path, same key the seed build uses
 *   GITHUB_REPOSITORY   "owner/repo"; set automatically inside GitHub Actions
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSeedManifest } from "./build-server-artifact.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const manifestModule = require("../shared/artifact-core/manifest.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");

// Matches desktop/src/shared/artifact-ota.cjs's GITHUB_CHANNEL_BASE owner/repo
// and scripts/mirror-release-to-atomgit.mjs's DEFAULT_GITHUB_REPOSITORY.
const DEFAULT_REPO = "liliMozi/openhanako";

const TRAIN_RELEASE_NOTES =
  "Hot-update train release. Holds one train's signed archives and manifest "
  + "(train.json / train.json.sig); already-installed clients download from "
  + "here automatically. This is not an installer download page.";

const CHANNELS_RELEASE_NOTES =
  "Live channel pointer release. stable.json / beta.json (and their .sig "
  + "files) are overwritten in place on every publish; installed clients "
  + "poll only these two static files to discover the newest train.";

// ── argument parsing ────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{tag: string, channel: "stable"|"beta", dryRun: boolean}}
 */
export function parseArgs(argv) {
  const args = { tag: null, channel: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--channel") args.channel = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`publish-train: unknown argument ${arg}`);
  }
  if (!args.tag) throw new Error("publish-train: --tag is required");
  if (args.channel !== "stable" && args.channel !== "beta") {
    throw new Error(`publish-train: --channel must be "stable" or "beta" (got ${JSON.stringify(args.channel)})`);
  }
  return args;
}

// ── archive filename parsing (matches packServerArchive/packRendererArtifact
//    naming in scripts/build-server-artifact.mjs) ───────────────────────────

const SERVER_ARCHIVE_RE = /^server-(.+)-([a-z0-9]+)-([a-z0-9]+)\.tar\.gz$/;
const RENDERER_ARCHIVE_RE = /^renderer-(.+)\.tar\.gz$/;

/**
 * @param {string} filename
 * @returns {{version: string, platform: string, arch: string} | null}
 */
export function parseServerArchiveName(filename) {
  const match = SERVER_ARCHIVE_RE.exec(filename);
  if (!match) return null;
  return { version: match[1], platform: match[2], arch: match[3] };
}

/**
 * @param {string} filename
 * @returns {{version: string} | null}
 */
export function parseRendererArchiveName(filename) {
  const match = RENDERER_ARCHIVE_RE.exec(filename);
  if (!match) return null;
  return { version: match[1] };
}

// ── train number / mirrors ──────────────────────────────────────────────

/**
 * Anti-rollback lives here: the next train is always "last published + 1"
 * for THIS channel, or 1 if the channel has never published. A channel
 * pointer that exists but carries an unparseable train number is a hard
 * error — guessing (e.g. restarting from 1) would silently break the
 * monotonic chain client's `checkMonotonic` relies on.
 * @param {{train: number} | null} existingChannelManifest
 * @returns {number}
 */
export function computeNextTrain(existingChannelManifest) {
  if (existingChannelManifest === null || existingChannelManifest === undefined) return 1;
  const { train } = existingChannelManifest;
  if (!Number.isInteger(train) || train < 0) {
    throw new Error(
      `publish-train: existing channel manifest has an unparseable train field (${JSON.stringify(train)}); `
        + "refusing to guess a starting point — that would break the anti-rollback chain. Fix the published "
        + "channel pointer manually before retrying.",
    );
  }
  return train + 1;
}

/**
 * AtomGit does not mirror the `train-<N>` release tag yet — only the
 * `channels` pointer tag has scheduled mirroring wired up (see the note in
 * desktop/src/shared/artifact-ota.cjs above ATOMGIT_CHANNEL_BASE). GitHub
 * is therefore the only mirror for now; add the AtomGit base here once a
 * `--tag train-<N>` mirror job exists.
 * @param {{repo: string, train: number}} opts
 * @returns {string[]}
 */
export function computeMirrors({ repo, train }) {
  if (!repo || !repo.includes("/")) {
    throw new Error(`computeMirrors: repo must be "owner/repo", got ${JSON.stringify(repo)}`);
  }
  if (!Number.isInteger(train) || train < 1) {
    throw new Error(`computeMirrors: train must be a positive integer, got ${JSON.stringify(train)}`);
  }
  return [`https://github.com/${repo}/releases/download/train-${train}`];
}

// ── manifest assembly (reuses buildSeedManifest, never a parallel builder) ─

/**
 * Assembles one schema-1 train manifest covering every platform-arch server
 * archive plus the shared renderer archive. `minShell` and `contract` are
 * NOT invented here: each platform-arch entry is produced by calling
 * `buildSeedManifest` (the same function the seed/train-0 build uses) and
 * the per-platform results are merged, so both fields — and the schema
 * number — come from that one source. `buildSeedManifest` computes them
 * the same way regardless of platform/arch, so the per-call results are
 * expected to agree; the check below is a cheap guard against that
 * assumption silently breaking in the future, not a live concern today.
 * @param {{
 *   version: string, releasedAt: string, keyId: string,
 *   channel: "stable"|"beta", train: number,
 *   rendererEntry: {sha256: string, size: number, archiveName: string},
 *   serverEntries: Array<{platform: string, arch: string, sha256: string, size: number, archiveName: string}>,
 *   mirrors: string[], rolloutSalt: string,
 * }} opts
 * @returns {object} a schema-1 manifest, already self-validated
 */
export function assembleTrainManifest({
  version,
  releasedAt,
  keyId,
  channel,
  train,
  rendererEntry,
  serverEntries,
  mirrors,
  rolloutSalt,
}) {
  if (!Array.isArray(serverEntries) || serverEntries.length === 0) {
    throw new Error("assembleTrainManifest: at least one server artifact entry is required");
  }

  const perPlatform = serverEntries.map((entry) =>
    buildSeedManifest({
      version,
      platform: entry.platform,
      arch: entry.arch,
      keyId,
      releasedAt,
      renderer: rendererEntry,
      server: entry,
    }));

  const base = perPlatform[0];
  for (const m of perPlatform) {
    if (m.schema !== base.schema || m.minShell !== base.minShell || JSON.stringify(m.contract) !== JSON.stringify(base.contract)) {
      throw new Error(
        "assembleTrainManifest: buildSeedManifest produced different schema/minShell/contract across platforms "
          + "for the same version/keyId/releasedAt — this should be impossible; refusing to merge",
      );
    }
  }

  const mergedServer = Object.assign({}, ...perPlatform.map((m) => m.artifacts.server));

  const manifest = {
    schema: base.schema,
    train,
    channel,
    releasedAt,
    keyId,
    minShell: base.minShell,
    contract: base.contract,
    urgent: false,
    rollout: { percent: 100, salt: rolloutSalt },
    artifacts: { renderer: base.artifacts.renderer, server: mergedServer },
    mirrors,
  };

  manifestModule.validateManifest(manifest); // self-check before it ever gets signed/published
  return manifest;
}

// ── resumable-publish comparison (version + sha256 only; deliberately
//    ignores channel/releasedAt/rollout.salt, which differ run-to-run and
//    channel-to-channel by design) ──────────────────────────────────────

/**
 * @param {object} a
 * @param {object} b
 * @returns {{matches: boolean, mismatches: string[]}}
 */
export function diffManifestArtifacts(a, b) {
  const mismatches = [];
  const ar = a.artifacts && a.artifacts.renderer;
  const br = b.artifacts && b.artifacts.renderer;
  if (!ar || !br || ar.version !== br.version || ar.sha256 !== br.sha256) {
    mismatches.push(
      `renderer: version(${ar ? ar.version : "missing"} vs ${br ? br.version : "missing"}) `
        + `sha256(${ar ? ar.sha256 : "missing"} vs ${br ? br.sha256 : "missing"})`,
    );
  }
  const aServers = (a.artifacts && a.artifacts.server) || {};
  const bServers = (b.artifacts && b.artifacts.server) || {};
  const keys = new Set([...Object.keys(aServers), ...Object.keys(bServers)]);
  for (const key of keys) {
    const av = aServers[key];
    const bv = bServers[key];
    if (!av || !bv || av.version !== bv.version || av.sha256 !== bv.sha256) {
      mismatches.push(
        `server.${key}: version(${av ? av.version : "missing"} vs ${bv ? bv.version : "missing"}) `
          + `sha256(${av ? av.sha256 : "missing"} vs ${bv ? bv.sha256 : "missing"})`,
      );
    }
  }
  return { matches: mismatches.length === 0, mismatches };
}

/**
 * Throws with a descriptive message when `existingTrainManifest`'s
 * artifacts don't match `candidateManifest`'s — a real conflict that needs
 * a human, never silently resolved by picking one side.
 * @param {object} candidateManifest
 * @param {object} existingTrainManifest
 */
export function assertArtifactsMatchForResume(candidateManifest, existingTrainManifest) {
  const diff = diffManifestArtifacts(candidateManifest, existingTrainManifest);
  if (!diff.matches) {
    throw new Error(
      `publish-train: train ${candidateManifest.train} release already exists but its artifacts differ from `
        + "this run's freshly-built boxes -- this is a real conflict, not a safe resume:\n"
        + diff.mismatches.map((m) => `  - ${m}`).join("\n"),
    );
  }
}

// ── HANA_SIGN_KEY guard (mirrors requireSignKeyPath in build-server-artifact.mjs) ─

function requireSignKeyPath(env) {
  const signKeyPath = env.HANA_SIGN_KEY;
  if (!signKeyPath) {
    throw new Error(
      "publish-train: HANA_SIGN_KEY is not set. A published channel pointer MUST be signed; "
        + "set HANA_SIGN_KEY=<private-key-path> (same key the seed build uses).",
    );
  }
  if (!fs.existsSync(signKeyPath)) {
    throw new Error(`publish-train: HANA_SIGN_KEY points at a missing file: ${signKeyPath}`);
  }
  return signKeyPath;
}

// ── gh CLI shell (thin IO layer, all mockable via deps) ─────────────────

function ghExec(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function defaultReleaseExists(tag) {
  try {
    ghExec(["release", "view", tag, "--json", "tagName"]);
    return true;
  } catch {
    return false;
  }
}

function defaultReleaseAssetNames(tag) {
  const out = ghExec(["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function defaultDownloadAssets(tag, patterns, destDir) {
  const args = ["release", "download", tag, "--dir", destDir, "--clobber"];
  for (const p of patterns) args.push("--pattern", p);
  ghExec(args);
}

function defaultCreateRelease(tag, files, { title, notes }) {
  ghExec(["release", "create", tag, ...files, "--title", title, "--notes", notes, "--prerelease"]);
}

function defaultUploadAssets(tag, files) {
  ghExec(["release", "upload", tag, ...files, "--clobber"]);
}

function defaultSignManifest(manifestPath, signKeyPath) {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts", "artifact-sign.mjs"), "--key", signKeyPath, "--file", manifestPath],
    { stdio: "pipe" },
  );
}

// ── box discovery: download the tag's archives, parse + hash them ───────

/**
 * @param {{tag: string, workDir: string, deps: object}} opts
 * @returns {Promise<{
 *   serverEntries: Array<{platform: string, arch: string, archiveName: string, filePath: string, sha256: string, size: number}>,
 *   rendererEntry: {archiveName: string, filePath: string, sha256: string, size: number},
 * }>}
 */
export async function discoverBoxes({ tag, workDir, deps }) {
  const version = tag.replace(/^v/, "");
  deps.downloadAssets(tag, ["server-*.tar.gz", "renderer-*.tar.gz"], workDir);

  const files = deps.readdir(workDir);
  const serverFiles = files.filter((f) => f.startsWith("server-") && f.endsWith(".tar.gz")).sort();
  const rendererFiles = files.filter((f) => f.startsWith("renderer-") && f.endsWith(".tar.gz")).sort();

  if (rendererFiles.length !== 1) {
    throw new Error(
      `discoverBoxes: expected exactly one renderer archive on release ${tag}, found ${rendererFiles.length} `
        + `(${rendererFiles.join(", ") || "none"})`,
    );
  }
  if (serverFiles.length === 0) {
    throw new Error(`discoverBoxes: no server archives found on release ${tag}`);
  }

  const serverEntries = [];
  for (const filename of serverFiles) {
    const parsed = parseServerArchiveName(filename);
    if (!parsed) throw new Error(`discoverBoxes: could not parse server archive filename: ${filename}`);
    if (parsed.version !== version) {
      throw new Error(
        `discoverBoxes: server archive ${filename} carries version ${parsed.version}, expected ${version} `
          + `(release tag ${tag}) — stale asset on the release?`,
      );
    }
    const filePath = path.join(workDir, filename);
    serverEntries.push({
      platform: parsed.platform,
      arch: parsed.arch,
      archiveName: filename,
      filePath,
      sha256: await deps.sha256File(filePath),
      size: deps.statSize(filePath),
    });
  }

  const rendererFilename = rendererFiles[0];
  const rendererParsed = parseRendererArchiveName(rendererFilename);
  if (!rendererParsed) throw new Error(`discoverBoxes: could not parse renderer archive filename: ${rendererFilename}`);
  if (rendererParsed.version !== version) {
    throw new Error(
      `discoverBoxes: renderer archive ${rendererFilename} carries version ${rendererParsed.version}, expected `
        + `${version} (release tag ${tag}) — stale asset on the release?`,
    );
  }
  const rendererFilePath = path.join(workDir, rendererFilename);
  const rendererEntry = {
    archiveName: rendererFilename,
    filePath: rendererFilePath,
    sha256: await deps.sha256File(rendererFilePath),
    size: deps.statSize(rendererFilePath),
  };

  return { serverEntries, rendererEntry };
}

// ── per-channel publish orchestration ────────────────────────────────────

/**
 * @param {{
 *   tag: string, channel: "stable"|"beta", dryRun: boolean, repo: string,
 *   releasedAt: string, boxes: object, env: NodeJS.ProcessEnv, deps: object,
 *   log: (msg: string) => void,
 * }} opts
 * @returns {Promise<{action: "dry-run"|"created"|"resumed", channel: string, train: number, trainTag: string}>}
 */
export async function publishChannel({ tag, channel, dryRun, repo, releasedAt, boxes, env, deps, log }) {
  const version = tag.replace(/^v/, "");
  const keyId = loadPinnedKeyset()[0].keyId;

  const channelsExists = deps.releaseExists("channels");
  let existingChannelManifest = null;
  if (channelsExists) {
    const assetNames = deps.releaseAssetNames("channels");
    if (assetNames.includes(`${channel}.json`)) {
      const dir = deps.mkdtemp(`hana-publish-train-pointer-read-${channel}-`);
      deps.downloadAssets("channels", [`${channel}.json`], dir);
      existingChannelManifest = manifestModule.parseManifest(deps.readFile(path.join(dir, `${channel}.json`)));
    }
  }

  const train = computeNextTrain(existingChannelManifest);
  const mirrors = computeMirrors({ repo, train });
  const rolloutSalt = deps.randomSalt();
  const candidateManifest = assembleTrainManifest({
    version,
    releasedAt,
    keyId,
    channel,
    train,
    rendererEntry: boxes.rendererEntry,
    serverEntries: boxes.serverEntries,
    mirrors,
    rolloutSalt,
  });

  const trainTag = `train-${train}`;

  if (dryRun) {
    log(`[dry-run] channel=${channel}: would target ${trainTag} (previous train on this channel: ${existingChannelManifest ? existingChannelManifest.train : "none"})`);
    log(`[dry-run] candidate manifest:\n${JSON.stringify(candidateManifest, null, 2)}`);
    return { action: "dry-run", channel, train, trainTag };
  }

  const signKeyPath = requireSignKeyPath(env);
  const trainExists = deps.releaseExists(trainTag);
  let resumed = false;

  if (trainExists) {
    const dir = deps.mkdtemp(`hana-publish-train-existing-${trainTag}-`);
    deps.downloadAssets(trainTag, ["train.json"], dir);
    const existingManifest = manifestModule.parseManifest(deps.readFile(path.join(dir, "train.json")));
    assertArtifactsMatchForResume(candidateManifest, existingManifest); // throws on real conflict
    resumed = true;
    log(`[publish-train] ${trainTag} already carries matching artifacts; skipping box upload for channel=${channel}`);
  } else {
    const workDir = deps.mkdtemp(`hana-publish-train-new-${trainTag}-`);
    const manifestPath = path.join(workDir, "train.json");
    deps.writeFile(manifestPath, JSON.stringify(candidateManifest, null, 2) + "\n");
    deps.signManifest(manifestPath, signKeyPath);
    const files = [
      ...boxes.serverEntries.map((e) => e.filePath),
      boxes.rendererEntry.filePath,
      manifestPath,
      `${manifestPath}.sig`,
    ];
    deps.createRelease(trainTag, files, { title: trainTag, notes: TRAIN_RELEASE_NOTES });
    log(`[publish-train] created ${trainTag} for channel=${channel} (train ${train})`);
  }

  // The channel pointer is always OUR OWN freshly signed manifest — never a
  // byte-copy of another channel's train.json — so `<channel>.json` always
  // carries the correct channel name even when it happens to share a
  // train-N box release with another channel (see file header).
  const pointerDir = deps.mkdtemp(`hana-publish-train-pointer-write-${channel}-`);
  const pointerManifestPath = path.join(pointerDir, `${channel}.json`);
  deps.writeFile(pointerManifestPath, JSON.stringify(candidateManifest, null, 2) + "\n");
  deps.signManifest(pointerManifestPath, signKeyPath);
  const pointerFiles = [pointerManifestPath, `${pointerManifestPath}.sig`];

  if (!channelsExists) {
    deps.createRelease("channels", pointerFiles, { title: "channels", notes: CHANNELS_RELEASE_NOTES });
  } else {
    deps.uploadAssets("channels", pointerFiles);
  }
  log(`[publish-train] channel=${channel} pointer now at train ${train}`);

  return { action: resumed ? "resumed" : "created", channel, train, trainTag };
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [depsOverride] - injectable IO layer for tests
 */
export async function run(argv = process.argv.slice(2), env = process.env, depsOverride = {}) {
  const args = parseArgs(argv);
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPO;

  const deps = {
    releaseExists: defaultReleaseExists,
    releaseAssetNames: defaultReleaseAssetNames,
    downloadAssets: defaultDownloadAssets,
    createRelease: defaultCreateRelease,
    uploadAssets: defaultUploadAssets,
    signManifest: defaultSignManifest,
    sha256File: activation.sha256File,
    statSize: (p) => fs.statSync(p).size,
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, data) => fs.writeFileSync(p, data),
    readdir: (p) => fs.readdirSync(p),
    mkdtemp: (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    randomSalt: () => crypto.randomBytes(16).toString("hex"),
    now: () => new Date().toISOString(),
    ...depsOverride,
  };
  const log = deps.log || console.log;

  const boxesWorkDir = deps.mkdtemp(`hana-publish-train-boxes-${args.channel}-`);
  const boxes = await discoverBoxes({ tag: args.tag, workDir: boxesWorkDir, deps });
  const releasedAt = deps.now();

  const result = await publishChannel({
    tag: args.tag,
    channel: args.channel,
    dryRun: args.dryRun,
    repo,
    releasedAt,
    boxes,
    env,
    deps,
    log,
  });

  log(`[publish-train] done: ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
