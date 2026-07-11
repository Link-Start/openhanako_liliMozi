import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assembleTrainManifest,
  assertArtifactsMatchForResume,
  computeMirrors,
  computeNextTrain,
  diffManifestArtifacts,
  discoverBoxes,
  parseArgs,
  parseRendererArchiveName,
  parseServerArchiveName,
  publishChannel,
  releaseExistsFromExec,
} from "../scripts/publish-train.mjs";

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
  vi.restoreAllMocks();
});

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

function sampleServerEntries() {
  return [
    { platform: "darwin", arch: "arm64", archiveName: "server-1.2.3-darwin-arm64.tar.gz", sha256: HEX_A, size: 111 },
    { platform: "linux", arch: "x64", archiveName: "server-1.2.3-linux-x64.tar.gz", sha256: HEX_B, size: 222 },
  ];
}

function sampleRendererEntry() {
  return { archiveName: "renderer-1.2.3.tar.gz", sha256: HEX_C, size: 333 };
}

function buildSampleManifest(overrides: Partial<Parameters<typeof assembleTrainManifest>[0]> = {}) {
  return assembleTrainManifest({
    version: "1.2.3",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: "2026a",
    channel: "stable",
    train: 1,
    rendererEntry: sampleRendererEntry(),
    serverEntries: sampleServerEntries(),
    mirrors: ["https://github.com/liliMozi/openhanako/releases/download/train-1"],
    rolloutSalt: "test-salt",
    ...overrides,
  });
}

describe("publish-train: parseArgs", () => {
  it("parses tag + channel", () => {
    expect(parseArgs(["--tag", "v1.2.3", "--channel", "stable"])).toEqual({
      tag: "v1.2.3",
      channel: "stable",
      dryRun: false,
    });
  });

  it("parses --dry-run", () => {
    expect(parseArgs(["--tag", "v1.2.3", "--channel", "beta", "--dry-run"])).toEqual({
      tag: "v1.2.3",
      channel: "beta",
      dryRun: true,
    });
  });

  it("requires --tag", () => {
    expect(() => parseArgs(["--channel", "stable"])).toThrow(/--tag is required/);
  });

  it("rejects an unknown channel", () => {
    expect(() => parseArgs(["--tag", "v1.2.3", "--channel", "canary"])).toThrow(/must be "stable" or "beta"/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--tag", "v1.2.3", "--channel", "stable", "--nope"])).toThrow(/unknown argument/);
  });
});

describe("publish-train: archive filename parsing", () => {
  it("parses a server archive name", () => {
    expect(parseServerArchiveName("server-0.385.14-darwin-arm64.tar.gz")).toEqual({
      version: "0.385.14",
      platform: "darwin",
      arch: "arm64",
    });
    expect(parseServerArchiveName("server-0.385.14-win32-x64.tar.gz")).toEqual({
      version: "0.385.14",
      platform: "win32",
      arch: "x64",
    });
  });

  it("returns null for names that don't match", () => {
    expect(parseServerArchiveName("renderer-0.385.14.tar.gz")).toBeNull();
    expect(parseServerArchiveName("server-0.385.14-darwin-arm64.zip")).toBeNull();
  });

  it("parses a renderer archive name", () => {
    expect(parseRendererArchiveName("renderer-0.385.14.tar.gz")).toEqual({ version: "0.385.14" });
  });

  it("returns null for a non-renderer name", () => {
    expect(parseRendererArchiveName("server-0.385.14-darwin-arm64.tar.gz")).toBeNull();
  });
});

describe("publish-train: computeNextTrain (anti-rollback)", () => {
  it("starts at 1 when the channel has never published", () => {
    expect(computeNextTrain(null)).toBe(1);
    expect(computeNextTrain(undefined)).toBe(1);
  });

  it("increments the existing train", () => {
    expect(computeNextTrain({ train: 5 })).toBe(6);
  });

  it("hard-errors on an unparseable train field instead of guessing", () => {
    expect(() => computeNextTrain({ train: "five" as unknown as number })).toThrow(/unparseable train field/);
    expect(() => computeNextTrain({ train: -1 })).toThrow(/unparseable train field/);
    expect(() => computeNextTrain({ train: 1.5 })).toThrow(/unparseable train field/);
  });
});

describe("publish-train: computeMirrors", () => {
  it("builds the GitHub train-N download base", () => {
    expect(computeMirrors({ repo: "liliMozi/openhanako", train: 6 })).toEqual([
      "https://github.com/liliMozi/openhanako/releases/download/train-6",
    ]);
  });

  it("rejects a malformed repo", () => {
    expect(() => computeMirrors({ repo: "openhanako", train: 1 })).toThrow(/repo must be/);
  });

  it("rejects a non-positive train", () => {
    expect(() => computeMirrors({ repo: "liliMozi/openhanako", train: 0 })).toThrow(/train must be a positive integer/);
  });
});

describe("publish-train: assembleTrainManifest (reuses buildSeedManifest, no parallel builder)", () => {
  it("merges per-platform server entries under one manifest carrying minShell/contract from buildSeedManifest", () => {
    const manifest = buildSampleManifest();
    expect(manifest.schema).toBe(1);
    expect(manifest.train).toBe(1);
    expect(manifest.channel).toBe("stable");
    expect(manifest.minShell).toBe("1.2.3"); // sourced from buildSeedManifest's own `minShell: version` convention
    expect(manifest.contract).toEqual({ preload: 1, serverProtocol: 1 }); // sourced from buildSeedManifest, not invented here
    expect(manifest.rollout).toEqual({ percent: 100, salt: "test-salt" });
    expect(manifest.mirrors).toEqual(["https://github.com/liliMozi/openhanako/releases/download/train-1"]);
    expect(Object.keys(manifest.artifacts.server).sort()).toEqual(["darwin-arm64", "linux-x64"]);
    expect(manifest.artifacts.server["darwin-arm64"]).toEqual({
      version: "1.2.3", sha256: HEX_A, size: 111, path: "server-1.2.3-darwin-arm64.tar.gz",
    });
    expect(manifest.artifacts.renderer).toEqual({
      version: "1.2.3", sha256: HEX_C, size: 333, path: "renderer-1.2.3.tar.gz",
    });
  });

  it("passes manifestModule.validateManifest (self-checked before signing)", () => {
    expect(() => buildSampleManifest()).not.toThrow();
  });

  it("refuses to build a manifest with zero server entries", () => {
    expect(() => buildSampleManifest({ serverEntries: [] })).toThrow(/at least one server artifact entry/);
  });
});

describe("publish-train: diffManifestArtifacts / assertArtifactsMatchForResume", () => {
  it("reports a match when version+sha256 agree, even if channel/releasedAt/salt differ", () => {
    const a = buildSampleManifest({ channel: "stable", releasedAt: "2026-07-11T00:00:00.000Z", rolloutSalt: "s1" });
    const b = buildSampleManifest({ channel: "beta", releasedAt: "2026-07-11T00:05:00.000Z", rolloutSalt: "s2" });
    expect(diffManifestArtifacts(a, b)).toEqual({ matches: true, mismatches: [] });
    expect(() => assertArtifactsMatchForResume(a, b)).not.toThrow();
  });

  it("reports a mismatch when a server archive's sha256 differs", () => {
    const a = buildSampleManifest();
    const differentEntries = sampleServerEntries();
    differentEntries[0] = { ...differentEntries[0], sha256: "f".repeat(64) };
    const b = buildSampleManifest({ serverEntries: differentEntries });
    const diff = diffManifestArtifacts(a, b);
    expect(diff.matches).toBe(false);
    expect(diff.mismatches[0]).toMatch(/server\.darwin-arm64/);
  });

  it("throws with the mismatch details baked into the message (real conflict, hard error)", () => {
    const a = buildSampleManifest();
    const b = buildSampleManifest({ rendererEntry: { ...sampleRendererEntry(), sha256: "d".repeat(64) } });
    expect(() => assertArtifactsMatchForResume(a, b)).toThrow(/real conflict, not a safe resume/);
    expect(() => assertArtifactsMatchForResume(a, b)).toThrow(/renderer:/);
  });
});

describe("publish-train: discoverBoxes", () => {
  function seedDownloadedBoxes(dir: string, version: string) {
    fs.writeFileSync(path.join(dir, `server-${version}-darwin-arm64.tar.gz`), "server-mac-bytes");
    fs.writeFileSync(path.join(dir, `server-${version}-linux-x64.tar.gz`), "server-linux-bytes");
    fs.writeFileSync(path.join(dir, `renderer-${version}.tar.gz`), "renderer-bytes");
  }

  it("parses and hashes every downloaded archive", async () => {
    const dir = makeTempDir("hana-discover-boxes-");
    seedDownloadedBoxes(dir, "1.2.3");
    const downloadAssets = vi.fn();
    const result = await discoverBoxes({
      tag: "v1.2.3",
      workDir: dir,
      deps: {
        downloadAssets,
        readdir: (p: string) => fs.readdirSync(p),
        sha256File: async (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
        statSize: (p: string) => fs.statSync(p).size,
      },
    });
    expect(downloadAssets).toHaveBeenCalledWith("v1.2.3", ["server-*.tar.gz", "renderer-*.tar.gz"], dir);
    expect(result.serverEntries).toHaveLength(2);
    expect(result.serverEntries.map((e: { platform: string }) => e.platform).sort()).toEqual(["darwin", "linux"]);
    expect(result.rendererEntry.archiveName).toBe("renderer-1.2.3.tar.gz");
    expect(result.rendererEntry.sha256).toHaveLength(64);
  });

  it("hard-errors when more than one renderer archive is present", async () => {
    const dir = makeTempDir("hana-discover-boxes-");
    seedDownloadedBoxes(dir, "1.2.3");
    fs.writeFileSync(path.join(dir, "renderer-1.2.3-dup.tar.gz"), "dup");
    await expect(
      discoverBoxes({
        tag: "v1.2.3",
        workDir: dir,
        deps: {
          downloadAssets: vi.fn(),
          readdir: (p: string) => fs.readdirSync(p),
          sha256File: async () => HEX_A,
          statSize: () => 1,
        },
      }),
    ).rejects.toThrow(/expected exactly one renderer archive/);
  });

  it("hard-errors when an archive's embedded version doesn't match the release tag", async () => {
    const dir = makeTempDir("hana-discover-boxes-");
    seedDownloadedBoxes(dir, "9.9.9"); // stale version vs the v1.2.3 tag below
    await expect(
      discoverBoxes({
        tag: "v1.2.3",
        workDir: dir,
        deps: {
          downloadAssets: vi.fn(),
          readdir: (p: string) => fs.readdirSync(p),
          sha256File: async () => HEX_A,
          statSize: () => 1,
        },
      }),
    ).rejects.toThrow(/does not match|expected 1\.2\.3/);
  });
});

describe("publish-train: releaseExistsFromExec (only a real not-found reads as absent)", () => {
  // Error shape matches what execFileSync throws for a failed gh call with
  // encoding "utf8" and piped stdio: message "Command failed: ..." plus the
  // captured stderr as a string property.
  function makeExecError(stderr: string) {
    const err = new Error(`Command failed: gh release view some-tag --json tagName\n${stderr}`);
    (err as Error & { stderr: string }).stderr = stderr;
    (err as Error & { status: number }).status = 1;
    return err;
  }

  it("returns true when the gh call succeeds", () => {
    expect(releaseExistsFromExec("train-1", () => '{"tagName":"train-1"}')).toBe(true);
  });

  it('returns false on the exact "release not found" stderr gh emits for a missing release', () => {
    // Measured against gh 2.92.0: `gh release view <missing-tag> --json tagName`
    // exits 1 with stderr "release not found\n".
    const exec = vi.fn(() => {
      throw makeExecError("release not found\n");
    });
    expect(releaseExistsFromExec("train-1", exec)).toBe(false);
  });

  it("rethrows auth/network/rate-limit failures instead of reading them as absent", () => {
    for (const stderr of [
      "HTTP 401: Bad credentials (https://api.github.com/graphql)\n",
      "HTTP 403: API rate limit exceeded\n",
      "error connecting to api.github.com\n",
    ]) {
      const exec = vi.fn(() => {
        throw makeExecError(stderr);
      });
      expect(() => releaseExistsFromExec("train-1", exec)).toThrow(/gh release view train-1 failed/);
    }
  });

  it("rethrows errors that carry no stderr at all (spawn failure, gh missing)", () => {
    const exec = vi.fn(() => {
      throw new Error("spawn gh ENOENT");
    });
    expect(() => releaseExistsFromExec("train-1", exec)).toThrow(/spawn gh ENOENT/);
  });
});

describe("publish-train: publishChannel", () => {
  function baseDeps(overrides: Record<string, unknown> = {}) {
    return {
      releaseExists: vi.fn().mockReturnValue(false),
      releaseAssetNames: vi.fn().mockReturnValue([]),
      downloadAssets: vi.fn(),
      createRelease: vi.fn(),
      uploadAssets: vi.fn(),
      signManifest: vi.fn(),
      mkdtemp: (prefix: string) => makeTempDir(prefix),
      writeFile: (p: string, data: string | Buffer) => fs.writeFileSync(p, data),
      readFile: (p: string) => fs.readFileSync(p),
      randomSalt: () => "fixed-salt",
      log: () => {},
      ...overrides,
    };
  }

  const boxes = { serverEntries: sampleServerEntries(), rendererEntry: sampleRendererEntry() };
  const env = { HANA_SIGN_KEY: "/dev/null" }; // requireSignKeyPath only checks existence; /dev/null exists everywhere this test runs

  it("dry-run computes and prints the plan but calls zero publish operations", async () => {
    const deps = baseDeps();
    const result = await publishChannel({
      tag: "v1.2.3", channel: "stable", dryRun: true, repo: "liliMozi/openhanako",
      releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
    });
    expect(result.action).toBe("dry-run");
    expect(result.train).toBe(1);
    expect(deps.createRelease).not.toHaveBeenCalled();
    expect(deps.uploadAssets).not.toHaveBeenCalled();
    expect(deps.signManifest).not.toHaveBeenCalled();
  });

  it("first-ever publish: creates both the train release and the channels release", async () => {
    const deps = baseDeps(); // releaseExists() -> false for everything: channels AND train-1 are both new
    const result = await publishChannel({
      tag: "v1.2.3", channel: "stable", dryRun: false, repo: "liliMozi/openhanako",
      releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
    });
    expect(result).toEqual({ action: "created", channel: "stable", train: 1, trainTag: "train-1" });
    expect(deps.createRelease).toHaveBeenCalledTimes(2);
    expect((deps.createRelease as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("train-1");
    expect((deps.createRelease as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("channels");
    expect(deps.uploadAssets).not.toHaveBeenCalled();
    expect(deps.signManifest).toHaveBeenCalledTimes(2); // train.json + channel pointer
  });

  it("channels release already exists (another channel published before): uploads instead of creating it", async () => {
    const deps = baseDeps({
      releaseExists: vi.fn((tag: string) => tag === "channels"), // channels exists, train-1 does not
      releaseAssetNames: vi.fn().mockReturnValue(["stable.json", "stable.json.sig"]), // beta not published yet
    });
    const result = await publishChannel({
      tag: "v1.2.3", channel: "beta", dryRun: false, repo: "liliMozi/openhanako",
      releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
    });
    expect(result.action).toBe("created");
    expect(deps.createRelease).toHaveBeenCalledTimes(1); // only train-1 (channels already exists)
    expect(deps.createRelease).toHaveBeenCalledWith("train-1", expect.any(Array), expect.objectContaining({ title: "train-1" }));
    expect(deps.uploadAssets).toHaveBeenCalledTimes(1);
    expect(deps.uploadAssets).toHaveBeenCalledWith("channels", expect.any(Array));
  });

  it("resumes when train-N already exists with byte-identical artifacts (interrupted or other-channel run)", async () => {
    // Simulate: channel's own last train was 5 -> next is 6. train-6 was already
    // created (by this same channel's earlier interrupted run, or by the other
    // channel publishing the identical archives first).
    const priorManifest = buildSampleManifest({ train: 5, channel: "stable" });
    const existingTrain6 = buildSampleManifest({ train: 6, channel: "stable", releasedAt: "2026-07-10T00:00:00.000Z", rolloutSalt: "old-salt" });

    const deps = baseDeps({
      releaseExists: vi.fn((tag: string) => tag === "channels" || tag === "train-6"),
      releaseAssetNames: vi.fn().mockReturnValue(["stable.json", "stable.json.sig"]),
      downloadAssets: vi.fn((tag: string, _patterns: string[], destDir: string) => {
        if (tag === "channels") {
          fs.writeFileSync(path.join(destDir, "stable.json"), JSON.stringify(priorManifest));
        } else if (tag === "train-6") {
          fs.writeFileSync(path.join(destDir, "train.json"), JSON.stringify(existingTrain6));
        }
      }),
    });

    const result = await publishChannel({
      tag: "v1.2.3", channel: "stable", dryRun: false, repo: "liliMozi/openhanako",
      releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
    });

    expect(result).toEqual({ action: "resumed", channel: "stable", train: 6, trainTag: "train-6" });
    expect(deps.createRelease).not.toHaveBeenCalled(); // train-6 box upload skipped
    expect(deps.uploadAssets).toHaveBeenCalledTimes(1); // pointer still gets updated
    expect(deps.uploadAssets).toHaveBeenCalledWith("channels", expect.any(Array));
    expect(deps.signManifest).toHaveBeenCalledTimes(1); // only the fresh channel pointer, not train.json (reused as-is)
  });

  it("hard-errors when train-N already exists with DIFFERENT artifacts (real conflict)", async () => {
    const priorManifest = buildSampleManifest({ train: 5, channel: "stable" });
    const conflictingEntries = sampleServerEntries();
    conflictingEntries[0] = { ...conflictingEntries[0], sha256: "9".repeat(64) };
    const existingTrain6 = buildSampleManifest({ train: 6, channel: "stable", serverEntries: conflictingEntries });

    const deps = baseDeps({
      releaseExists: vi.fn((tag: string) => tag === "channels" || tag === "train-6"),
      releaseAssetNames: vi.fn().mockReturnValue(["stable.json", "stable.json.sig"]),
      downloadAssets: vi.fn((tag: string, _patterns: string[], destDir: string) => {
        if (tag === "channels") {
          fs.writeFileSync(path.join(destDir, "stable.json"), JSON.stringify(priorManifest));
        } else if (tag === "train-6") {
          fs.writeFileSync(path.join(destDir, "train.json"), JSON.stringify(existingTrain6));
        }
      }),
    });

    await expect(
      publishChannel({
        tag: "v1.2.3", channel: "stable", dryRun: false, repo: "liliMozi/openhanako",
        releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
      }),
    ).rejects.toThrow(/real conflict, not a safe resume/);
    expect(deps.createRelease).not.toHaveBeenCalled();
    expect(deps.uploadAssets).not.toHaveBeenCalled();
  });

  it("propagates a non-not-found releaseExists failure and makes zero publish calls", async () => {
    const deps = baseDeps({
      releaseExists: vi.fn(() => {
        throw new Error("gh release view channels failed: HTTP 401: Bad credentials");
      }),
    });
    await expect(
      publishChannel({
        tag: "v1.2.3", channel: "stable", dryRun: false, repo: "liliMozi/openhanako",
        releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(deps.createRelease).not.toHaveBeenCalled();
    expect(deps.uploadAssets).not.toHaveBeenCalled();
    expect(deps.signManifest).not.toHaveBeenCalled();
  });

  it("beta.json always carries channel:\"beta\" even when resuming off a train stable created first", async () => {
    const priorBetaManifest = buildSampleManifest({ train: 5, channel: "beta" });
    const existingTrain6FromStable = buildSampleManifest({ train: 6, channel: "stable" }); // same artifacts, created by stable's run

    let publishedPointerBytes: Buffer | null = null;
    const deps = baseDeps({
      releaseExists: vi.fn((tag: string) => tag === "channels" || tag === "train-6"),
      releaseAssetNames: vi.fn().mockReturnValue(["beta.json", "beta.json.sig", "stable.json", "stable.json.sig"]),
      downloadAssets: vi.fn((tag: string, _patterns: string[], destDir: string) => {
        if (tag === "channels") {
          fs.writeFileSync(path.join(destDir, "beta.json"), JSON.stringify(priorBetaManifest));
        } else if (tag === "train-6") {
          fs.writeFileSync(path.join(destDir, "train.json"), JSON.stringify(existingTrain6FromStable));
        }
      }),
      writeFile: (p: string, data: string | Buffer) => {
        if (path.basename(p) === "beta.json") publishedPointerBytes = Buffer.from(data);
        fs.writeFileSync(p, data);
      },
    });

    const result = await publishChannel({
      tag: "v1.2.3", channel: "beta", dryRun: false, repo: "liliMozi/openhanako",
      releasedAt: "2026-07-11T00:00:00.000Z", boxes, env, deps, log: () => {},
    });

    expect(result.action).toBe("resumed");
    expect(publishedPointerBytes).not.toBeNull();
    const published = JSON.parse((publishedPointerBytes as unknown as Buffer).toString("utf8"));
    expect(published.channel).toBe("beta");
    expect(published.train).toBe(6);
  });
});
