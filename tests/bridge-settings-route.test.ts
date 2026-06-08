import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createBridgeRoute } from "../server/routes/bridge.ts";

function makeApp() {
  let readOnly = false;
  let receiptEnabled = false;
  let permissionMode = "operate";
  const agent = {
    id: "hana",
    sessionDir: "/tmp/hana-bridge-settings",
    config: { bridge: {} },
    updateConfig: vi.fn(),
  };
  const engine = {
    currentAgentId: "hana",
    getAgent: vi.fn((id) => id === "hana" ? agent : null),
    getBridgeIndex: vi.fn(() => ({})),
    getBridgeReadOnly: vi.fn(() => readOnly),
    setBridgeReadOnly: vi.fn((next) => { readOnly = !!next; }),
    getBridgePermissionMode: vi.fn(() => permissionMode),
    setBridgePermissionMode: vi.fn((next) => { permissionMode = next; }),
    getBridgeReceiptEnabled: vi.fn(() => receiptEnabled),
    setBridgeReceiptEnabled: vi.fn((next) => { receiptEnabled = !!next; }),
  };
  const bridgeManager = {
    getStatus: vi.fn(() => ({})),
    getMessages: vi.fn(() => []),
    stopPlatform: vi.fn(),
    startPlatformFromConfig: vi.fn(),
  };
  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, bridgeManager));
  return { app, engine };
}

describe("bridge settings route", () => {
  it("returns the persisted global bridge settings after saving", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readOnly: true, receiptEnabled: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgeReadOnly).toHaveBeenCalledWith(true);
    expect(engine.setBridgeReceiptEnabled).toHaveBeenCalledWith(true);
    expect(body).toEqual({
      ok: true,
      readOnly: true,
      permissionMode: "read_only",
      receiptEnabled: true,
    });
  });

  it("persists the explicit bridge permission mode while preserving legacy readOnly shape", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgePermissionMode).toHaveBeenCalledWith("auto");
    expect(engine.setBridgeReadOnly).not.toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      readOnly: false,
      permissionMode: "auto",
      receiptEnabled: false,
    });
  });
});
