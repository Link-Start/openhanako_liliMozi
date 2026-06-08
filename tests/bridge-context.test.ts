import { describe, expect, it } from "vitest";
import {
  buildBridgeContext,
  buildBridgePromptLine,
} from "../lib/bridge/bridge-context.ts";

describe("bridge context", () => {
  it("formats a low-salience Chinese platform line", () => {
    const context = buildBridgeContext({
      sessionKey: "wx_dm_owner@hana",
      role: "owner",
    }, "zh");

    expect(buildBridgePromptLine(context, "zh")).toBe(
      "当前用户正通过微信与你对话，仅在需要理解当前平台或“这里”等指代时参考。",
    );
  });

  it("formats a low-salience English platform line", () => {
    const context = buildBridgeContext({
      sessionKey: "fs_dm_owner@hana",
      role: "owner",
    }, "en");

    expect(buildBridgePromptLine(context, "en")).toBe(
      "The user is currently talking with you through Feishu; use this only when interpreting the current platform or references like \"here.\"",
    );
  });

  it("builds detailed bridge state without turning guest chats into owner notification targets", () => {
    const ownerContext = buildBridgeContext({
      sessionKey: "fs_dm_open-id@hana",
      role: "owner",
      userId: "owner-user",
      chatId: "oc_chat",
      agentId: "hana",
    }, "zh");

    expect(ownerContext).toMatchObject({
      isBridgeSession: true,
      platform: "feishu",
      platformLabel: "飞书",
      chatType: "dm",
      role: "owner",
      sessionKey: "fs_dm_open-id@hana",
      agentId: "hana",
      userId: "owner-user",
      chatId: "oc_chat",
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
        contextPolicy: "record_when_delivered",
      },
    });

    const guestContext = buildBridgeContext({
      sessionKey: "tg_group_g1@hana",
      role: "guest",
      userId: "guest-user",
      chatId: "g1",
      agentId: "hana",
    }, "zh");

    expect(guestContext).toMatchObject({
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });
});
