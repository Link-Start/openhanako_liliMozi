import { describe, expect, it, vi } from "vitest";
import { NotificationService, formatNotificationText } from "../lib/notifications/notification-service.js";

describe("NotificationService", () => {
  it("keeps legacy notify calls on the desktop channel", async () => {
    const desktopEvents = [];
    const service = new NotificationService({
      emitDesktop: (event) => desktopEvents.push(event),
      getBridgeManager: () => null,
    });

    const result = await service.notify({ title: "提醒", body: "该喝水了" }, { agentId: "hana" });

    expect(desktopEvents).toEqual([
      { title: "提醒", body: "该喝水了", agentId: "hana", desktopFocusPolicy: "always" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
  });

  it("passes desktop focus policy to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "完成",
        body: "这一轮已经结束",
        desktopFocusPolicy: "when_unfocused",
      },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "完成",
      body: "这一轮已经结束",
      agentId: "hana",
      desktopFocusPolicy: "when_unfocused",
    });
  });

  it("passes the notification sessionPath to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "完成",
        body: "这一轮已经结束",
        sessionPath: "/tmp/finished.jsonl",
      },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "完成",
      body: "这一轮已经结束",
      agentId: "hana",
      desktopFocusPolicy: "always",
      sessionPath: "/tmp/finished.jsonl",
    });
  });

  it("skips repeated notifications with the same explicit idempotency key", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const first = await service.notify(
      { title: "提醒", body: "喝水", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "hana" },
    );
    const second = await service.notify(
      { title: "提醒", body: "喝水", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
    expect(second).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      skipped: true,
      deliveries: [{
        channel: "notification",
        status: "skipped",
        reason: "duplicate notification",
      }],
    });
  });

  it("delivers explicit bridge owner notifications through BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hana",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      {
        title: "AI 日报",
        body: "今天有三条新闻。",
        channels: ["bridge_owner"],
      },
      { agentId: "hana" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "AI 日报\n\n今天有三条新闻。",
      "hana",
      { contextPolicy: "record_when_delivered" },
    );
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{
        channel: "bridge_owner",
        status: "sent",
        platform: "wechat",
        sessionKey: "wx_dm_wx-user@hana",
      }],
    });
  });

  it("passes preferred bridge platforms to BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "feishu",
        chatId: "oc_owner",
        sessionKey: "fs_dm_owner@hana",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    await service.notify(
      {
        title: "提醒",
        body: "正文",
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
      },
      { agentId: "hana" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "提醒\n\n正文",
      "hana",
      {
        contextPolicy: "record_when_delivered",
        bridgePlatforms: ["feishu"],
      },
    );
  });

  it("reports explicit bridge owner delivery failure when the channel is unavailable", async () => {
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI 日报", body: "正文", channels: ["bridge_owner"] },
      { agentId: "hana" },
    );

    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([{
      channel: "bridge_owner",
      status: "failed",
      error: "bridge manager unavailable",
    }]);
  });

  it("fails unsupported explicit channels instead of falling back to desktop", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI 日报", body: "正文", channels: ["sms"] },
      { agentId: "hana" },
    );

    expect(emitDesktop).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([{
      channel: "sms",
      status: "failed",
      error: "unsupported notification channel: sms",
    }]);
  });
});

describe("formatNotificationText", () => {
  it("uses the exact user-visible text for bridge delivery", () => {
    expect(formatNotificationText("标题", "正文")).toBe("标题\n\n正文");
    expect(formatNotificationText("", "正文")).toBe("正文");
    expect(formatNotificationText("标题", "")).toBe("标题");
  });
});
