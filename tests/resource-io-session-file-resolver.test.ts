import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { SessionFileResolverProvider } from "../lib/resource-io/providers/session-file-resolver.ts";

describe("SessionFileResolverProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-session-file-"));
    const sessionPath = path.join(tempRoot, "agents", "hana", "sessions", "a.jsonl");
    const filePath = path.join(tempRoot, "files", "note.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    fs.writeFileSync(filePath, "# hello\n", "utf-8");
    const registry = new SessionFileRegistry({
      managedCacheRoot: path.join(tempRoot, "session-files"),
    });
    const entry = registry.registerFile({
      sessionPath,
      filePath,
      label: "note.md",
      origin: "test",
      storageKind: "external",
    });
    return {
      entry,
      filePath,
      provider: new SessionFileResolverProvider({ sessionFiles: registry }),
    };
  }

  it("resolves SessionFile stat, read, and materialize without exposing it as writable", async () => {
    const { entry, filePath, provider } = setup();
    const realPath = fs.realpathSync(filePath);

    const stat = await provider.stat({ kind: "session-file", fileId: entry.id });
    expect(stat).toMatchObject({
      exists: true,
      isDirectory: false,
      resourceKey: `session_file:${entry.id}`,
      resource: {
        kind: "session-file",
        fileId: entry.id,
        provider: "session_file",
        filePath: realPath,
      },
      version: { size: 8 },
    });

    const read = await provider.read({ kind: "session-file", fileId: entry.id });
    expect(read.content.toString("utf-8")).toBe("# hello\n");

    const materialized = await provider.materialize({ kind: "session-file", fileId: entry.id });
    expect(materialized.filePath).toBe(realPath);

    await expect(provider.write({ kind: "session-file", fileId: entry.id }, "changed"))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# hello\n");
  });
});
