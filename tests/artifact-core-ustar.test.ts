import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { afterEach, describe, expect, it } from "vitest";

import ustarModule from "../shared/artifact-core/ustar.cjs";

const { extract, packTree } = ustarModule as {
  extract: (archivePath: string, destDir: string) => Promise<void>;
  packTree: (srcDir: string, archivePath: string) => Promise<void>;
};

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

// ---------------------------------------------------------------------
// Hand-crafted raw ustar bytes, deliberately independent of ustar.cjs's
// own header builder — these fixtures stand in for an attacker who
// controls the archive bytes directly and would never go through our
// trusted packTree() (which itself refuses to emit unsafe entries).
// ---------------------------------------------------------------------

const BLOCK_SIZE = 512;

function octal(value: number, len: number) {
  return value.toString(8).padStart(len - 1, "0") + "\0";
}

function rawHeaderBlock(opts: {
  name: string;
  typeflag: string;
  linkname?: string;
  size?: number;
  mode?: number;
}): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE, 0);
  const nameBuf = Buffer.from(opts.name, "utf8");
  nameBuf.copy(block, 0);
  block.write(octal(opts.mode ?? 0o644, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1"); // uid
  block.write(octal(0, 8), 116, "latin1"); // gid
  block.write(octal(opts.size ?? 0, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1"); // mtime
  block.write("        ", 148, "latin1"); // chksum placeholder
  block.write(opts.typeflag, 156, "latin1");
  if (opts.linkname) {
    Buffer.from(opts.linkname, "utf8").copy(block, 157);
  }
  Buffer.from("ustar\0", "utf8").copy(block, 257);
  block.write("00", 263, "latin1");

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += block[i];
  block.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

/** Builds a minimal valid single-entry ustar.tar.gz with the given raw header + content. */
function buildRawArchive(headerBlock: Buffer, content: Buffer = Buffer.alloc(0)): Buffer {
  const pad = content.length % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (content.length % BLOCK_SIZE);
  const terminator = Buffer.alloc(BLOCK_SIZE * 2, 0);
  const tarBytes = Buffer.concat([headerBlock, content, Buffer.alloc(pad, 0), terminator]);
  return zlib.gzipSync(tarBytes);
}

function writeArchive(dir: string, name: string, bytes: Buffer): string {
  const archivePath = path.join(dir, name);
  fs.writeFileSync(archivePath, bytes);
  return archivePath;
}

describe("ustar extract: malicious archive rejection", () => {
  it("rejects a symlink entry", async () => {
    const dir = makeTempDir("hana-ustar-symlink-");
    const header = rawHeaderBlock({ name: "evil-link", typeflag: "2", linkname: "/etc/passwd" });
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/symlink/i);
    expect(fs.existsSync(path.join(destDir, "evil-link"))).toBe(false);
  });

  it("rejects a hardlink entry", async () => {
    const dir = makeTempDir("hana-ustar-hardlink-");
    const header = rawHeaderBlock({ name: "evil-hardlink", typeflag: "1", linkname: "some-other-file" });
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/hardlink/i);
    expect(fs.existsSync(path.join(destDir, "evil-hardlink"))).toBe(false);
  });

  it("rejects an absolute path entry", async () => {
    const dir = makeTempDir("hana-ustar-abs-");
    const content = Buffer.from("pwned");
    const header = rawHeaderBlock({ name: "/etc/hana-pwned", typeflag: "0", size: content.length });
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header, content));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/absolute/i);
  });

  it("rejects a path-traversal (..) entry", async () => {
    const dir = makeTempDir("hana-ustar-traversal-");
    const content = Buffer.from("pwned");
    const header = rawHeaderBlock({ name: "../../../tmp/hana-pwned", typeflag: "0", size: content.length });
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header, content));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/traversal/i);
    // must not have escaped destDir's parent
    expect(fs.existsSync("/tmp/hana-pwned")).toBe(false);
  });

  it("rejects a path-traversal entry hidden mid-path", async () => {
    const dir = makeTempDir("hana-ustar-traversal-mid-");
    const content = Buffer.from("pwned");
    const header = rawHeaderBlock({ name: "safe/../../escape", typeflag: "0", size: content.length });
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header, content));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/traversal/i);
  });

  it("rejects an unknown typeflag", async () => {
    const dir = makeTempDir("hana-ustar-unknown-");
    const header = rawHeaderBlock({ name: "device-node", typeflag: "3" }); // char device
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/typeflag/i);
  });

  it("rejects a corrupted header checksum", async () => {
    const dir = makeTempDir("hana-ustar-corrupt-");
    const header = rawHeaderBlock({ name: "file.txt", typeflag: "0", size: 0 });
    header[150] = header[150] ^ 0xff; // flip a byte inside the checksum field itself
    const archivePath = writeArchive(dir, "evil.tar.gz", buildRawArchive(header));
    const destDir = path.join(dir, "dest");

    await expect(extract(archivePath, destDir)).rejects.toThrow(/checksum/i);
  });
});

describe("ustar packTree / extract round-trip", () => {
  it("reproduces a nested tree exactly, including executable bit collapse", async () => {
    const root = makeTempDir("hana-ustar-roundtrip-");
    const srcDir = path.join(root, "src");
    const destDir = path.join(root, "dest");
    const archivePath = path.join(root, "out.tar.gz");

    await fsp.mkdir(path.join(srcDir, "bin"), { recursive: true });
    await fsp.mkdir(path.join(srcDir, "lib", "nested"), { recursive: true });
    await fsp.writeFile(path.join(srcDir, "README.md"), "# hello\n");
    await fsp.writeFile(path.join(srcDir, "bin", "run.sh"), "#!/bin/sh\necho hi\n");
    await fsp.chmod(path.join(srcDir, "bin", "run.sh"), 0o700); // has an exec bit
    await fsp.writeFile(path.join(srcDir, "lib", "nested", "data.bin"), Buffer.from([0, 1, 2, 255, 254]));

    await packTree(srcDir, archivePath);
    expect(fs.existsSync(archivePath)).toBe(true);

    await extract(archivePath, destDir);

    expect(fs.readFileSync(path.join(destDir, "README.md"), "utf8")).toBe("# hello\n");
    expect(fs.readFileSync(path.join(destDir, "bin", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.readFileSync(path.join(destDir, "lib", "nested", "data.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255, 254]),
    );

    // Windows does not persist Unix permission bits through chmod/stat the way
    // POSIX does (files commonly surface as 0o666). Mode collapse is a Unix
    // contract; on win32 we still verify content + tree shape above.
    if (process.platform !== "win32") {
      const runShMode = fs.statSync(path.join(destDir, "bin", "run.sh")).mode & 0o777;
      const readmeMode = fs.statSync(path.join(destDir, "README.md")).mode & 0o777;
      expect(runShMode).toBe(0o755); // executable bit preserved, collapsed to 0o755
      expect(readmeMode).toBe(0o644); // non-executable collapsed to 0o644
    }

    expect(fs.statSync(path.join(destDir, "lib", "nested")).isDirectory()).toBe(true);
  });

  it("packs an empty directory tree without error", async () => {
    const root = makeTempDir("hana-ustar-empty-");
    const srcDir = path.join(root, "src");
    const destDir = path.join(root, "dest");
    const archivePath = path.join(root, "out.tar.gz");
    await fsp.mkdir(srcDir, { recursive: true });

    await packTree(srcDir, archivePath);
    await extract(archivePath, destDir);

    expect(fs.existsSync(destDir)).toBe(true);
  });

  it("refuses to pack a symlink in the source tree", async () => {
    const root = makeTempDir("hana-ustar-pack-symlink-");
    const srcDir = path.join(root, "src");
    const archivePath = path.join(root, "out.tar.gz");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "real.txt"), "hi");
    await fsp.symlink(path.join(srcDir, "real.txt"), path.join(srcDir, "link.txt"));

    await expect(packTree(srcDir, archivePath)).rejects.toThrow(/symlink/i);
  });
});
