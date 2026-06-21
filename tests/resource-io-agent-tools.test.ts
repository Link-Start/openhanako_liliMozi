import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapResourceIoFileTools } from "../lib/resource-io/agent-tools.ts";

describe("ResourceIO agent tools", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.unstubAllGlobals();
  });

  it("normalizes local path aliases before delegating write and emits a resource change", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-io-tools-"));
    const execute = vi.fn(async (_toolCallId, params) => {
      fs.mkdirSync(path.dirname(params.path), { recursive: true });
      fs.writeFileSync(params.path, params.content, "utf-8");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const emitEvent = vi.fn();
    const [write] = wrapResourceIoFileTools([
      {
        name: "write",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute,
      },
    ], {
      cwd: tmpDir,
      getSessionPath: () => "/sessions/a.jsonl",
      emitEvent,
    });

    const result = await write.execute("write-1", {
      file_path: "notes/a.md",
      content: "# A\n",
    });

    const absolutePath = path.join(tmpDir, "notes", "a.md");
    expect(result.content[0].text).toBe("ok");
    expect(execute).toHaveBeenCalledWith(
      "write-1",
      expect.objectContaining({ path: absolutePath, content: "# A\n" }),
    );
    expect(fs.readFileSync(absolutePath, "utf-8")).toBe("# A\n");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_write",
      sessionPath: "/sessions/a.jsonl",
      filePath: absolutePath,
      resource: expect.objectContaining({
        provider: "local_fs",
        path: absolutePath,
      }),
    }), "/sessions/a.jsonl");
  });

  it("passes SessionFile references to read and rejects SessionFile writes explicitly", async () => {
    const readExecute = vi.fn(async (_toolCallId, params) => ({
      content: [{ type: "text", text: `read:${params.path}` }],
    }));
    const writeExecute = vi.fn();
    const resourceIO = {
      materialize: vi.fn(async () => ({ filePath: "/tmp/materialized.md" })),
    };
    const [read, write] = wrapResourceIoFileTools([
      { name: "read", parameters: { type: "object", required: ["path"], properties: {} }, execute: readExecute },
      { name: "write", parameters: { type: "object", required: ["path"], properties: {} }, execute: writeExecute },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO,
    });

    const readResult = await read.execute("read-1", {
      resource: { kind: "session-file", fileId: "sf_123", sessionPath: "/sessions/owner.jsonl" },
    });
    const writeResult = await write.execute("write-1", {
      fileId: "sf_123",
      content: "new",
    });

    expect(readResult.content[0].text).toBe("read:/tmp/materialized.md");
    expect(resourceIO.materialize).toHaveBeenCalledWith({
      kind: "session-file",
      fileId: "sf_123",
      sessionPath: "/sessions/owner.jsonl",
    });
    expect(readExecute).toHaveBeenCalledWith(
      "read-1",
      expect.objectContaining({ path: "/tmp/materialized.md" }),
    );
    expect(writeExecute).not.toHaveBeenCalled();
    expect(writeResult.content[0].text).toContain("cannot be written or edited directly");
  });

  it("allows URL reads and keeps URL targets read-only", async () => {
    const delegateExecute = vi.fn();
    const resourceIO = {
      read: vi.fn(async () => ({
        content: Buffer.from("hello url"),
        version: { size: 9, etag: "\"abc\"" },
      })),
    };
    const [read, write] = wrapResourceIoFileTools([
      { name: "read", parameters: { type: "object", required: ["path"], properties: {} }, execute: delegateExecute },
      { name: "write", parameters: { type: "object", required: ["path"], properties: {} }, execute: delegateExecute },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO,
    });

    const readResult = await read.execute("read-url", { url: "https://example.com/a.txt" });
    const writeResult = await write.execute("write-url", { url: "https://example.com/a.txt", content: "x" });

    expect(readResult.content[0].text).toContain("hello url");
    expect(resourceIO.read).toHaveBeenCalledWith({ kind: "url", url: "https://example.com/a.txt" });
    expect(writeResult.content[0].text).toContain("read-only");
    expect(delegateExecute).not.toHaveBeenCalled();
  });
});
