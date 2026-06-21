import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";

export function createResourceIoRoute(engine) {
  const route = new Hono();
  const releases = new Map();

  route.post("/resource-io/watch", async (c) => {
    try {
      const body = await safeJson(c);
      const resource = body?.resource || body?.ref || body?.target || body;
      const release = engine.retainResourceWatch?.(resource);
      if (typeof release !== "function") {
        return c.json({ error: "resource watch unavailable" }, 500);
      }
      const watchId = crypto.randomUUID();
      releases.set(watchId, release);
      return c.json({ ok: true, watchId });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.delete("/resource-io/watch/:watchId", (c) => {
    const watchId = c.req.param("watchId");
    const release = releases.get(watchId);
    if (!release) return c.json({ ok: true, released: false });
    releases.delete(watchId);
    release();
    return c.json({ ok: true, released: true });
  });

  route.post("/resource-io/stat", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.stat(resource);
  }));

  route.post("/resource-io/read", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    const result = await resourceIO.read(resource);
    return {
      ...result,
      content: Buffer.isBuffer(result.content)
        ? result.content.toString("utf-8")
        : Buffer.from(result.content || "").toString("utf-8"),
      encoding: "utf-8",
    };
  }));

  route.post("/resource-io/list", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.list(resource);
  }));

  route.post("/resource-io/search", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.search(resource, { query: body?.query });
  }));

  route.post("/resource-io/write", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target;
    return resourceIO.write(resource, String(body?.content ?? ""), {
      source: "api",
      reason: body?.reason || "resource_io_route",
      sessionPath: body?.sessionPath || null,
    });
  }));

  return route;
}

async function resourceJson(c, engine, handler) {
  try {
    const body = await safeJson(c);
    const resourceIO = engine.resourceIO || engine.getResourceIO?.();
    if (!resourceIO) return c.json({ error: "resource io unavailable" }, 500);
    return c.json(await handler(resourceIO, body));
  } catch (err) {
    return c.json({
      error: err?.message || String(err),
      ...(err?.code ? { code: err.code } : {}),
    }, err?.status || 400);
  }
}
