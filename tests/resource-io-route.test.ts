import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createResourceIoRoute } from "../server/routes/resource-io.ts";

describe("resource-io route", () => {
  it("retains and releases backend resource watches", async () => {
    const release = vi.fn();
    const retainResourceWatch = vi.fn(() => release);
    const app = new Hono();
    app.route("/api", createResourceIoRoute({
      retainResourceWatch,
    }));

    const watchRes = await app.request("/api/resource-io/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    const watchData = await watchRes.json();

    expect(watchRes.status).toBe(200);
    expect(retainResourceWatch).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp/a.md" });
    expect(typeof watchData.watchId).toBe("string");

    const releaseRes = await app.request(`/api/resource-io/watch/${watchData.watchId}`, {
      method: "DELETE",
    });
    const releaseData = await releaseRes.json();

    expect(releaseRes.status).toBe(200);
    expect(releaseData).toEqual({ ok: true, released: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("routes stat, read, list, and search through engine ResourceIO", async () => {
    const resourceIO = {
      stat: vi.fn(async () => ({ exists: true, resourceKey: "local_fs:/tmp/a.md" })),
      read: vi.fn(async () => ({ content: Buffer.from("hello"), version: { size: 5 } })),
      list: vi.fn(async () => ({ items: [{ name: "a.md", isDirectory: false }] })),
      search: vi.fn(async () => ({ matches: [{ filePath: "/tmp/a.md", line: 1, text: "hello" }] })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const statRes = await app.request("/api/resource-io/stat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    expect(await statRes.json()).toEqual({ exists: true, resourceKey: "local_fs:/tmp/a.md" });
    expect(resourceIO.stat).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp/a.md" });

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    expect(await readRes.json()).toEqual({ content: "hello", encoding: "utf-8", version: { size: 5 } });

    await app.request("/api/resource-io/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp" } }),
    });
    expect(resourceIO.list).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp" });

    await app.request("/api/resource-io/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp" }, query: "hello" }),
    });
    expect(resourceIO.search).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp" }, { query: "hello" });
  });
});
