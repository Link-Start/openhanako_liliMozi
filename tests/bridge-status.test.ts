import { describe, expect, it, vi } from "vitest";
import os from "os";

const createTelegramAdapter = vi.fn();
const createFeishuAdapter = vi.fn();
const createDingTalkAdapter = vi.fn();
const createQQAdapter = vi.fn();
const createWechatAdapter = vi.fn();

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: (...args) => createTelegramAdapter(...args),
}));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: (...args) => createFeishuAdapter(...args),
}));
vi.mock("../lib/bridge/dingtalk-adapter.js", () => ({
  createDingTalkAdapter: (...args) => createDingTalkAdapter(...args),
}));
vi.mock("../lib/bridge/qq-adapter.js", () => ({
  createQQAdapter: (...args) => createQQAdapter(...args),
}));
vi.mock("../lib/bridge/wechat-adapter.js", () => ({
  createWechatAdapter: (...args) => createWechatAdapter(...args),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

describe("BridgeManager platform status", () => {
  it("starts wechat in connecting state until the adapter reports readiness", () => {
    createTelegramAdapter.mockReset();
    createFeishuAdapter.mockReset();
    createDingTalkAdapter.mockReset();
    createQQAdapter.mockReset();
    createWechatAdapter.mockReset();
    createWechatAdapter.mockReturnValue({ stop: vi.fn() });

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatform("wechat", { botToken: "wx-token", hanaHome: os.tmpdir() }, "hana");

    expect(bm.getStatus("hana").wechat).toMatchObject({ status: "connecting", error: null });
  });

  it("reports DingTalk config errors when enabled credentials are incomplete", () => {
    createTelegramAdapter.mockReset();
    createFeishuAdapter.mockReset();
    createDingTalkAdapter.mockReset();
    createQQAdapter.mockReset();
    createWechatAdapter.mockReset();

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("dingtalk", {
      enabled: true,
      corpId: "corp-1",
      clientId: "dt-client",
      clientSecret: "dt-secret",
    }, "hana");

    expect(createDingTalkAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").dingtalk).toMatchObject({
      status: "error",
      error: expect.stringMatching(/enterprise robotCode/i),
    });
  });

  it("does not start DingTalk when the new token contract is missing corpId", () => {
    createDingTalkAdapter.mockReset();
    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("dingtalk", {
      enabled: true,
      clientId: "dt-client",
      clientSecret: "dt-secret",
      robotCode: "ding-robot",
    }, "hana");

    expect(createDingTalkAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").dingtalk).toMatchObject({
      status: "error",
      error: expect.stringMatching(/corpId/i),
    });
  });

  it("does not revive a legacy QQ token after canonical appSecret was cleared", () => {
    createQQAdapter.mockReset();
    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("qq", {
      enabled: true,
      appID: "qq-app",
      appSecret: "",
      token: "legacy-must-stay-cleared",
    }, "hana");

    expect(createQQAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").qq).toBeUndefined();
  });
});
