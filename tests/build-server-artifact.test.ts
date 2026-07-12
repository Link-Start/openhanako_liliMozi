import { createHash, generateKeyPairSync } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodesignArgs,
  buildSeedManifest,
  findMachOFiles,
  isMachOBuffer,
  packDualKindSeed,
  packRendererArtifact,
  packServerArchive,
  resolveBuildKeyset,
} from "../scripts/build-server-artifact.mjs";

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

function makeKeypairFiles(root: string, keyId = "testkey") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyPath = path.join(root, "test-sign-key.pem");
  const keysetPath = path.join(root, "test-keyset.json");
  fs.writeFileSync(keyPath, privatePem, { mode: 0o600 });
  fs.writeFileSync(keysetPath, JSON.stringify([{ keyId, publicKey: publicPem }], null, 2));
  return { keyPath, keysetPath, keyId };
}

function makeServerTree(root: string) {
  const outDir = path.join(root, "dist-server", "mac-arm64");
  fs.mkdirSync(path.join(outDir, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "bundle", "index.js"), "console.log('server');\n");
  fs.writeFileSync(path.join(outDir, "hana-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return outDir;
}

function makeRendererTree(root: string) {
  const rendererDir = path.join(root, "dist-renderer");
  fs.mkdirSync(path.join(rendererDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(rendererDir, "index.html"), "<!doctype html><html></html>\n");
  fs.writeFileSync(path.join(rendererDir, "assets", "index.js"), "console.log('renderer');\n");
  return rendererDir;
}

describe("build-server-artifact: Mach-O detection", () => {
  it("recognizes 64-bit and fat Mach-O magics and rejects text", () => {
    expect(isMachOBuffer(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]))).toBe(true); // MH_MAGIC_64 (LE on disk)
    expect(isMachOBuffer(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00]))).toBe(true); // FAT_MAGIC
    expect(isMachOBuffer(Buffer.from("#!/bin/sh\n"))).toBe(false);
    expect(isMachOBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(false); // ELF
    expect(isMachOBuffer(Buffer.from([]))).toBe(false);
  });

  it("finds Mach-O files recursively and skips scripts", () => {
    const root = makeTempDir("hana-macho-");
    fs.mkdirSync(path.join(root, "node_modules", "x", "build"), { recursive: true });
    fs.writeFileSync(path.join(root, "node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]));
    fs.writeFileSync(
      path.join(root, "node_modules", "x", "build", "addon.node"),
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 9]),
    );
    fs.writeFileSync(path.join(root, "hana-server"), "#!/bin/sh\n");
    const found = findMachOFiles(root).map((p: string) => path.relative(root, p)).sort();
    expect(found).toEqual(["node", path.join("node_modules", "x", "build", "addon.node")]);
  });
});

describe("build-server-artifact: buildCodesignArgs (darwin in-seed signing spec)", () => {
  it("falls back to ad-hoc signing when identity is empty or unset (local builds, byte-for-byte current behavior)", () => {
    expect(buildCodesignArgs({ identity: undefined, file: "/tree/node" })).toEqual([
      "--sign", "-", "--force", "/tree/node",
    ]);
    expect(buildCodesignArgs({ identity: "", file: "/tree/node_modules/x/addon.node" })).toEqual([
      "--sign", "-", "--force", "/tree/node_modules/x/addon.node",
    ]);
  });

  it("signs executables (non-.node Mach-O) with Developer ID + hardened runtime + secure timestamp", () => {
    const args = buildCodesignArgs({ identity: "ABCDEF0123456789", file: "/tree/node" });
    expect(args).toEqual([
      "--sign", "ABCDEF0123456789", "--timestamp", "--force", "--options", "runtime", "/tree/node",
    ]);
  });

  it("signs .node addons with Developer ID + secure timestamp but WITHOUT hardened runtime (matches the proven pre-sign CI spec)", () => {
    const args = buildCodesignArgs({ identity: "ABCDEF0123456789", file: "/tree/node_modules/x/build/addon.node" });
    expect(args).toEqual([
      "--sign", "ABCDEF0123456789", "--timestamp", "--force", "/tree/node_modules/x/build/addon.node",
    ]);
    expect(args).not.toContain("runtime");
  });

  it("never injects entitlements or keychain flags (not part of the proven notarized spec)", () => {
    const args = buildCodesignArgs({ identity: "ABCDEF0123456789", file: "/tree/node" });
    expect(args).not.toContain("--entitlements");
    expect(args).not.toContain("--keychain");
  });
});

describe("build-server-artifact: dual-kind seed manifest shape", () => {
  it("builds a schema-1 train-0 stable manifest carrying BOTH renderer and server entries", () => {
    const manifest = buildSeedManifest({
      version: "0.381.0",
      platform: "darwin",
      arch: "arm64",
      keyId: "2026a",
      releasedAt: "2026-07-11T00:00:00.000Z",
      renderer: { sha256: "b".repeat(64), size: 456, archiveName: "renderer-0.381.0.tar.gz" },
      server: { sha256: "a".repeat(64), size: 123, archiveName: "server-0.381.0-darwin-arm64.tar.gz" },
    });
    expect(manifest.schema).toBe(1);
    expect(manifest.train).toBe(0);
    expect(manifest.channel).toBe("stable");
    expect(manifest.keyId).toBe("2026a");
    expect(manifest.minShell).toBe("0.381.0");
    expect(manifest.artifacts.renderer).toEqual({
      version: "0.381.0",
      sha256: "b".repeat(64),
      size: 456,
      path: "renderer-0.381.0.tar.gz",
    });
    expect(manifest.artifacts.server["darwin-arm64"]).toEqual({
      version: "0.381.0",
      sha256: "a".repeat(64),
      size: 123,
      path: "server-0.381.0-darwin-arm64.tar.gz",
    });
  });
});

describe("build-server-artifact: keyset resolution", () => {
  it("defaults to the repo pinned keyset when HANA_SIGN_KEYSET is unset", () => {
    const { keyset } = resolveBuildKeyset({});
    expect(keyset[0].keyId).toBe("2026a");
  });

  it("uses the HANA_SIGN_KEYSET override file when set", () => {
    const root = makeTempDir("hana-keyset-");
    const { keysetPath, keyId } = makeKeypairFiles(root, "override1");
    const { keyset } = resolveBuildKeyset({ HANA_SIGN_KEYSET: keysetPath });
    expect(keyset[0].keyId).toBe(keyId);
  });

  it("hard-errors when HANA_SIGN_KEYSET points at a missing file", () => {
    expect(() => resolveBuildKeyset({ HANA_SIGN_KEYSET: "/nonexistent/keyset.json" })).toThrow(
      /HANA_SIGN_KEYSET/,
    );
  });
});

describe("build-server-artifact: packServerArchive (pack-only, no manifest)", () => {
  it("packs the server tree into an archive without touching manifests", async () => {
    const root = makeTempDir("hana-pack-server-");
    const outDir = makeServerTree(root);
    const artifactOutDir = path.join(root, "artifact");
    const result = await packServerArchive({
      outDir,
      artifactOutDir,
      version: "0.381.0",
      platform: "linux",
      arch: "x64",
      log: () => {},
    });
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(result.archiveName).toBe("server-0.381.0-linux-x64.tar.gz");
    expect(fs.existsSync(path.join(artifactOutDir, "seed-train.json"))).toBe(false);
  });

  it("signs Mach-O binaries BEFORE packing on darwin (sign first, pack second)", async () => {
    const root = makeTempDir("hana-pack-server-");
    const outDir = makeServerTree(root);
    const order: string[] = [];
    await packServerArchive({
      outDir,
      artifactOutDir: path.join(root, "artifact"),
      version: "0.381.0",
      platform: "darwin",
      arch: "arm64",
      log: () => {},
      deps: {
        signMachOFiles: async () => {
          order.push("sign");
        },
        packTree: async () => {
          order.push("pack");
        },
        sha256File: async () => "e".repeat(64),
        statSize: () => 1,
      },
    });
    expect(order).toEqual(["sign", "pack"]);
  });

  it("passes env down to the darwin signer so HANA_MACHO_SIGN_IDENTITY reaches it (no process.env grabbing)", async () => {
    const root = makeTempDir("hana-pack-server-");
    const outDir = makeServerTree(root);
    let seenEnv: unknown = null;
    await packServerArchive({
      outDir,
      artifactOutDir: path.join(root, "artifact"),
      version: "0.381.0",
      platform: "darwin",
      arch: "arm64",
      env: { HANA_MACHO_SIGN_IDENTITY: "CAFEBABE" },
      log: () => {},
      deps: {
        signMachOFiles: async (_outDir: string, _log: (msg: string) => void, env: unknown) => {
          seenEnv = env;
        },
        packTree: async () => {},
        sha256File: async () => "e".repeat(64),
        statSize: () => 1,
      },
    });
    expect(seenEnv).toEqual({ HANA_MACHO_SIGN_IDENTITY: "CAFEBABE" });
  });

  it("does not run the darwin codesign pass for non-darwin targets", async () => {
    const root = makeTempDir("hana-pack-server-");
    const outDir = makeServerTree(root);
    let signCalled = false;
    await packServerArchive({
      outDir,
      artifactOutDir: path.join(root, "artifact"),
      version: "0.381.0",
      platform: "linux",
      arch: "x64",
      log: () => {},
      deps: {
        signMachOFiles: async () => {
          signCalled = true;
        },
      },
    });
    expect(signCalled).toBe(false);
  });

  it("cleans stale artifactOutDir contents from a previous build", async () => {
    const root = makeTempDir("hana-pack-server-");
    const outDir = makeServerTree(root);
    const artifactOutDir = path.join(root, "artifact");
    fs.mkdirSync(artifactOutDir, { recursive: true });
    fs.writeFileSync(path.join(artifactOutDir, "stale-server-0.1.0-darwin-arm64.tar.gz"), "stale");
    await packServerArchive({ outDir, artifactOutDir, version: "0.381.0", platform: "linux", arch: "x64", log: () => {} });
    expect(fs.existsSync(path.join(artifactOutDir, "stale-server-0.1.0-darwin-arm64.tar.gz"))).toBe(false);
  });
});

describe("build-server-artifact: packRendererArtifact", () => {
  it("packs the renderer tree, platform-independent", async () => {
    const root = makeTempDir("hana-pack-renderer-");
    const rendererDistDir = makeRendererTree(root);
    const artifactOutDir = path.join(root, "dist-renderer-artifact");
    const result = await packRendererArtifact({
      rendererDistDir,
      artifactOutDir,
      version: "0.381.0",
      log: () => {},
    });
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(result.archiveName).toBe("renderer-0.381.0.tar.gz");
  });

  it("refuses to pack when the renderer dist dir is missing (build ordering guard)", async () => {
    const root = makeTempDir("hana-pack-renderer-");
    await expect(
      packRendererArtifact({
        rendererDistDir: path.join(root, "nowhere"),
        artifactOutDir: path.join(root, "out"),
        version: "0.381.0",
        log: () => {},
      }),
    ).rejects.toThrow(/renderer dist dir not found/);
  });

  it("asserts the renderer tree carries no Mach-O binaries before packing (no silent inclusion)", async () => {
    const root = makeTempDir("hana-pack-renderer-");
    const rendererDistDir = makeRendererTree(root);
    // Simulate a native dependency accidentally landing in the renderer tree.
    fs.writeFileSync(path.join(rendererDistDir, "assets", "sneaky.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]));
    let packCalled = false;
    await expect(
      packRendererArtifact({
        rendererDistDir,
        artifactOutDir: path.join(root, "out"),
        version: "0.381.0",
        log: () => {},
        deps: {
          packTree: async () => {
            packCalled = true;
          },
        },
      }),
    ).rejects.toThrow(/Mach-O/);
    expect(packCalled).toBe(false);
  });

  it("cleans stale artifactOutDir contents from a previous build", async () => {
    const root = makeTempDir("hana-pack-renderer-");
    const rendererDistDir = makeRendererTree(root);
    const artifactOutDir = path.join(root, "dist-renderer-artifact");
    fs.mkdirSync(artifactOutDir, { recursive: true });
    fs.writeFileSync(path.join(artifactOutDir, "renderer-0.1.0.tar.gz"), "stale");
    await packRendererArtifact({ rendererDistDir, artifactOutDir, version: "0.381.0", log: () => {} });
    expect(fs.existsSync(path.join(artifactOutDir, "renderer-0.1.0.tar.gz"))).toBe(false);
  });
});

describe("build-server-artifact: packDualKindSeed guards and ordering", () => {
  function baseOpts(root: string) {
    return {
      outDir: makeServerTree(root),
      rendererDistDir: makeRendererTree(root),
      rendererArtifactOutDir: path.join(root, "dist-renderer-artifact"),
      artifactOutDir: path.join(root, "dist-server-artifact", "mac-arm64"),
      version: "0.381.0",
      platform: "linux",
      arch: "x64",
      log: () => {},
    };
  }

  it("hard-errors when HANA_SIGN_KEY is unset (never a silent skip)", async () => {
    const root = makeTempDir("hana-dual-");
    await expect(
      packDualKindSeed({ ...baseOpts(root), env: {} }),
    ).rejects.toThrow(/HANA_SIGN_KEY/);
  });

  it("hard-errors when HANA_SIGN_KEY points at a missing file", async () => {
    const root = makeTempDir("hana-dual-");
    await expect(
      packDualKindSeed({ ...baseOpts(root), env: { HANA_SIGN_KEY: path.join(root, "no-such-key.pem") } }),
    ).rejects.toThrow(/HANA_SIGN_KEY/);
  });

  it("end-to-end: packs both archives, signs and verifies a seed whose manifest matches both", async () => {
    const root = makeTempDir("hana-dual-e2e-");
    const { keyPath, keysetPath, keyId } = makeKeypairFiles(root, "e2e2026");
    const opts = baseOpts(root);

    const result = await packDualKindSeed({ ...opts, env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath } });

    expect(fs.existsSync(result.serverArchivePath)).toBe(true);
    expect(fs.existsSync(result.rendererArchivePath)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(fs.existsSync(result.sigPath)).toBe(true);
    // Renderer archive must be co-located with the server archive under the
    // SAME per-platform seed dir (extraResources picks up the whole dir).
    expect(path.dirname(result.rendererArchivePath)).toBe(opts.artifactOutDir);
    expect(path.dirname(result.serverArchivePath)).toBe(opts.artifactOutDir);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest.train).toBe(0);
    expect(manifest.keyId).toBe(keyId);
    expect(manifest.artifacts.renderer.sha256).toBe(createHash("sha256").update(fs.readFileSync(result.rendererArchivePath)).digest("hex"));
    expect(manifest.artifacts.server["linux-x64"].sha256).toBe(createHash("sha256").update(fs.readFileSync(result.serverArchivePath)).digest("hex"));
    expect(manifest.artifacts.server["linux-x64"].path).toBe(path.basename(result.serverArchivePath));
    expect(manifest.artifacts.renderer.path).toBe(path.basename(result.rendererArchivePath));

    // Exactly 4 files land in the per-platform seed dir.
    const files = fs.readdirSync(opts.artifactOutDir).sort();
    expect(files).toEqual(
      [path.basename(result.serverArchivePath), path.basename(result.rendererArchivePath), "seed-train.json", "seed-train.json.sig"].sort(),
    );
  });

  it("hard-errors at build time when the signing key does not match the packed keyset", async () => {
    const root = makeTempDir("hana-dual-mismatch-");
    const { keyPath } = makeKeypairFiles(root, "signer");
    const other = generateKeyPairSync("ed25519");
    const mismatchKeysetPath = path.join(root, "mismatch-keyset.json");
    fs.writeFileSync(
      mismatchKeysetPath,
      JSON.stringify([{ keyId: "signer", publicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString() }]),
    );
    await expect(
      packDualKindSeed({ ...baseOpts(root), env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: mismatchKeysetPath } }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it("refuses to build a seed when the renderer dist dir is missing (build ordering guard)", async () => {
    const root = makeTempDir("hana-dual-missing-renderer-");
    const { keyPath, keysetPath } = makeKeypairFiles(root);
    const opts = baseOpts(root);
    fs.rmSync(opts.rendererDistDir, { recursive: true, force: true });
    await expect(
      packDualKindSeed({ ...opts, env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath } }),
    ).rejects.toThrow(/renderer dist dir not found/);
  });
});

describe("build-server-artifact: packDualKindSeed prebuilt renderer archive reuse (CI single-source box)", () => {
  function baseOpts(root: string) {
    return {
      outDir: makeServerTree(root),
      rendererDistDir: makeRendererTree(root),
      rendererArtifactOutDir: path.join(root, "dist-renderer-artifact"),
      artifactOutDir: path.join(root, "dist-server-artifact", "mac-arm64"),
      version: "0.381.0",
      platform: "linux",
      arch: "x64",
      log: () => {},
    };
  }

  /** Packs a standalone renderer box, standing in for the shared CI job's output. */
  async function packSharedRendererBox(root: string, version = "0.381.0") {
    const sharedSourceDir = path.join(root, "shared-source-renderer");
    fs.mkdirSync(path.join(sharedSourceDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sharedSourceDir, "index.html"), "<!doctype html><html></html>\n");
    fs.writeFileSync(path.join(sharedSourceDir, "assets", "index.js"), "console.log('shared renderer');\n");
    return packRendererArtifact({
      rendererDistDir: sharedSourceDir,
      artifactOutDir: path.join(root, "shared-renderer-box"),
      version,
      log: () => {},
    });
  }

  it("reuses a prebuilt renderer archive instead of packing rendererDistDir on the spot", async () => {
    const root = makeTempDir("hana-dual-prebuilt-");
    const { keyPath, keysetPath } = makeKeypairFiles(root);
    const prebuilt = await packSharedRendererBox(root);

    const opts = {
      outDir: makeServerTree(root),
      // Deliberately missing: if packDualKindSeed still tried to pack this on the spot
      // (i.e. the prebuilt path were NOT honored), packRendererArtifact's own dist-dir
      // guard would throw "renderer dist dir not found" (see the regression test above).
      // A clean pass here proves on-the-spot packing never ran.
      rendererDistDir: path.join(root, "no-such-renderer-dist-dir"),
      rendererArtifactOutDir: path.join(root, "dist-renderer-artifact"),
      artifactOutDir: path.join(root, "dist-server-artifact", "mac-arm64"),
      version: "0.381.0",
      platform: "linux",
      arch: "x64",
      log: () => {},
    };

    const result = await packDualKindSeed({
      ...opts,
      env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath },
      prebuiltRendererArchive: prebuilt.archivePath,
    });

    // Manifest records the sha256/size of the prebuilt file, verified by independent hashing.
    const measuredSha256 = createHash("sha256").update(fs.readFileSync(prebuilt.archivePath)).digest("hex");
    expect(prebuilt.sha256).toBe(measuredSha256);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest.artifacts.renderer.sha256).toBe(measuredSha256);
    expect(manifest.artifacts.renderer.size).toBe(prebuilt.size);
    expect(manifest.artifacts.renderer.path).toBe("renderer-0.381.0.tar.gz");

    // Lands in both required locations with identical bytes: the per-platform seed dir
    // (what extraResources picks up) AND the shared artifact-out dir (what CI's
    // "Upload artifacts" step publishes as dist-renderer-artifact/renderer-*.tar.gz).
    const inSeedDir = path.join(opts.artifactOutDir, "renderer-0.381.0.tar.gz");
    const inSharedDir = path.join(opts.rendererArtifactOutDir, "renderer-0.381.0.tar.gz");
    expect(fs.existsSync(inSeedDir)).toBe(true);
    expect(fs.existsSync(inSharedDir)).toBe(true);
    expect(createHash("sha256").update(fs.readFileSync(inSeedDir)).digest("hex")).toBe(measuredSha256);
    expect(createHash("sha256").update(fs.readFileSync(inSharedDir)).digest("hex")).toBe(measuredSha256);
    expect(result.rendererArchivePath).toBe(inSeedDir);
  });

  it("picks up HANA_PREBUILT_RENDERER_BOX from env when the option is not passed explicitly", async () => {
    const root = makeTempDir("hana-dual-prebuilt-env-");
    const { keyPath, keysetPath } = makeKeypairFiles(root);
    const prebuilt = await packSharedRendererBox(root);
    const opts = baseOpts(root); // has a normal, valid rendererDistDir — must still be ignored

    const result = await packDualKindSeed({
      ...opts,
      env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath, HANA_PREBUILT_RENDERER_BOX: prebuilt.archivePath },
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest.artifacts.renderer.sha256).toBe(prebuilt.sha256);
    expect(manifest.artifacts.renderer.size).toBe(prebuilt.size);
  });

  it("hard-errors when the prebuilt renderer archive path does not exist", async () => {
    const root = makeTempDir("hana-dual-prebuilt-missing-");
    const { keyPath, keysetPath } = makeKeypairFiles(root);
    const opts = baseOpts(root);

    await expect(
      packDualKindSeed({
        ...opts,
        env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath },
        prebuiltRendererArchive: path.join(root, `renderer-${opts.version}.tar.gz`),
      }),
    ).rejects.toThrow(/prebuilt renderer archive path invalid/);
  });

  it("hard-errors when the prebuilt renderer archive filename does not match the build version", async () => {
    const root = makeTempDir("hana-dual-prebuilt-mismatch-");
    const { keyPath, keysetPath } = makeKeypairFiles(root);
    const opts = baseOpts(root); // version: "0.381.0"
    const wrongVersionArchive = path.join(root, "renderer-9.9.9.tar.gz");
    fs.writeFileSync(wrongVersionArchive, "not really a tar\n");

    await expect(
      packDualKindSeed({
        ...opts,
        env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEYSET: keysetPath },
        prebuiltRendererArchive: wrongVersionArchive,
      }),
    ).rejects.toThrow(/prebuilt renderer archive name mismatch/);
  });
});
