import { describe, expect, it, vi } from "vitest";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";

describe("ResourceIO provider contract", () => {
  it("dispatches by ResourceRef kind, checks capabilities, and emits mutation events", async () => {
    const changed = vi.fn();
    const localProvider = {
      capabilities: () => ({ stat: true, read: true, write: true, edit: true }),
      stat: vi.fn(async () => ({
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        exists: true,
        isDirectory: false,
      })),
      read: vi.fn(async () => ({
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        content: Buffer.from("hello"),
      })),
      write: vi.fn(async () => ({
        changeType: "modified" as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
      })),
      edit: vi.fn(async () => ({
        changeType: "modified" as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
      })),
    };
    const resourceIO = new ResourceIO({
      providers: { local_fs: localProvider },
      eventBus: { changed } as any,
      getSessionPath: () => "/sessions/a.jsonl",
    });

    await resourceIO.stat({ kind: "local-file", path: "/repo/a.md" });
    await resourceIO.read({ kind: "local-file", path: "/repo/a.md" });
    expect(changed).not.toHaveBeenCalled();

    await resourceIO.write({ kind: "local-file", path: "/repo/a.md" }, "hello again", {
      source: "agent_tool",
      reason: "agent_write",
    });
    await resourceIO.edit({ kind: "local-file", path: "/repo/a.md" }, [{ oldText: "hello", newText: "hello again" }], {
      source: "agent_tool",
      reason: "agent_edit",
    });

    expect(localProvider.edit).toHaveBeenCalledWith(
      { kind: "local-file", path: "/repo/a.md" },
      [{ oldText: "hello", newText: "hello again" }],
    );
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({
      source: "agent_tool",
      reason: "agent_edit",
      sessionPath: "/sessions/a.jsonl",
    }));
  });

  it("returns stable errors for missing providers and denied capabilities", async () => {
    const resourceIO = new ResourceIO({
      providers: {
        local_fs: {
          capabilities: () => ({ read: false }),
        },
      },
    });

    await expect(resourceIO.read({ kind: "resource", resourceId: "res_missing" }))
      .rejects.toMatchObject({ code: "provider_not_available" });
    await expect(resourceIO.read({ kind: "local-file", path: "/repo/a.md" }))
      .rejects.toMatchObject({ code: "capability_denied" });
  });
});
