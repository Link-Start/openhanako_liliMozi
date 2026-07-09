import { describe, expect, it, vi } from "vitest";

import {
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_STREAMING_CAPABILITIES,
  createDingTalkAdapter,
} from "../lib/bridge/dingtalk-adapter.ts";

type FakeWebSocketHandler = (payload?: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  options: any;
  sent: string[] = [];
  handlers = new Map<string, FakeWebSocketHandler[]>();

  constructor(url: string, options?: any) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, handler: FakeWebSocketHandler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload?: any) {
    for (const handler of this.handlers.get(event) || []) {
      handler(payload);
    }
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.emit("close");
  }
}

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeAdapter(
  fetchMock: ReturnType<typeof vi.fn>,
  onMessage = vi.fn(),
  onStatus = vi.fn(),
  overrides: Record<string, any> = {},
) {
  return createDingTalkAdapter({
    corpId: "corp-1",
    clientId: "dt-client",
    clientSecret: "dt-secret",
    robotCode: "ding-robot",
    agentId: "hana",
    onMessage,
    onStatus,
    fetchImpl: fetchMock as any,
    WebSocketImpl: FakeWebSocket as any,
    ...overrides,
  });
}

function streamEnvelope(data: any, messageId = "msg-1") {
  return JSON.stringify({
    type: "CALLBACK",
    headers: {
      topic: DINGTALK_BOT_CALLBACK_TOPIC,
      contentType: "application/json",
      messageId,
      time: Date.now(),
    },
    data: JSON.stringify(data),
  });
}

describe("DingTalk bridge adapter", () => {
  it("opens the official stream connection and subscribes to bot callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onStatus = vi.fn();

    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/gateway/connections/open",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(DINGTALK_BOT_CALLBACK_TOPIC),
      }),
    );
    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody).toMatchObject({
      clientId: "dt-client",
      clientSecret: "dt-secret",
      subscriptions: [{ topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" }],
    });
    expect(FakeWebSocket.instances[0].url).toBe("wss://api.dingtalk.com/connect?ticket=ticket-1");

    FakeWebSocket.instances[0].emit("open");
    expect(onStatus).toHaveBeenCalledWith("connected");

    adapter.stop();
  });

  it("normalizes DingTalk private text callbacks and acknowledges the stream message", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-private",
      conversationType: "1",
      msgId: "ding-msg-1",
      senderNick: "Alice",
      senderStaffId: "manager1234",
      senderId: "sender-open-id",
      senderAvatarUrl: "https://example.com/alice.png",
      msgtype: "text",
      text: { content: "hello DingTalk!" },
      robotCode: "ding-robot",
    }, "stream-msg-1"));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "dingtalk",
      agentId: "hana",
      chatId: "manager1234",
      userId: "manager1234",
      sessionKey: "dt_dm_manager1234@hana",
      text: "hello DingTalk!",
      senderName: "Alice",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
      principalId: "manager1234",
      isGroup: false,
      _msgId: "ding-msg-1",
    }));
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: "stream-msg-1",
      },
      message: "OK",
    });

    adapter.stop();
  });

  it("uses conversation-scoped session keys for group callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-group",
      conversationType: "2",
      msgId: "ding-msg-2",
      senderNick: "Bob",
      senderStaffId: "staff-bob",
      msgtype: "text",
      text: { content: "group hello" },
      robotCode: "ding-robot",
    }));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "cid-group",
      userId: "staff-bob",
      sessionKey: "dt_group_cid-group@hana",
      text: "group hello",
      isGroup: true,
    }));

    adapter.stop();
  });

  it("sends private and group replies through DingTalk robot REST APIs", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "group-task" }));

    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "direct hello", { targetScope: "dm" });
    await adapter.sendReply("cid-group", "group hello", { targetScope: "group" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/oauth2/corp-1/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "dt-client",
          client_secret: "dt-secret",
          grant_type: "client_credentials",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "token-1" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      robotCode: "ding-robot",
      userIds: ["manager1234"],
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "Hana", text: "direct hello" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "token-1" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      robotCode: "ding-robot",
      openConversationId: "cid-group",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "Hana", text: "group hello" }),
    });

    adapter.stop();
  });

  it("builds token and robot send requests from the DingTalk API base URL only", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://stream.example/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "group-task" }));

    const adapter = makeAdapter(fetchMock, vi.fn(), vi.fn(), {
      corpId: "corp/custom",
      apiBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0/",
      streamOpenUrl: "https://stream-gateway.example/v1.0/gateway/connections/open",
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "direct hello", { targetScope: "dm" });
    await adapter.sendReply("cid-group", "group hello", { targetScope: "group" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://stream-gateway.example/v1.0/gateway/connections/open",
      "https://tenant-gateway.example/dingtalk/v1.0/oauth2/corp%2Fcustom/token",
      "https://tenant-gateway.example/dingtalk/v1.0/robot/oToMessages/batchSend",
      "https://tenant-gateway.example/dingtalk/v1.0/robot/groupMessages/send",
    ]);

    adapter.stop();
  });

  it("reports outbound degradation after token failure and clears it after a successful reply", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ code: "dt-secret", message: "invalid dt-secret" }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-2", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].emit("open");

    await expect(adapter.sendReply("manager1234", "hello", { targetScope: "dm" }))
      .rejects.toThrow(/invalid \[redacted\].*code=\[redacted\]/);
    expect(onStatus).toHaveBeenCalledWith("connected");
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/invalid \[redacted\].*code=\[redacted\]/),
    );
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("dt-secret");

    await expect(adapter.sendReply("manager1234", "retry", { targetScope: "dm" }))
      .resolves.toMatchObject({ processQueryKey: "dm-task" });
    expect(onStatus.mock.calls.at(-1)).toEqual(["connected"]);

    adapter.stop();
  });

  it("redacts the access token from robot-send errors and degraded status", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-must-not-leak", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: "token-must-not-leak",
        message: "rejected token-must-not-leak",
      }, 403));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].emit("open");

    await expect(adapter.sendReply("manager1234", "hello", { targetScope: "dm" }))
      .rejects.toThrow(/rejected \[redacted\].*code=\[redacted\]/);
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("token-must-not-leak");
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/rejected \[redacted\].*code=\[redacted\]/),
    );

    adapter.stop();
  });

  it("redacts the one-time Stream ticket from WebSocket construction errors", async () => {
    class ThrowingWebSocket {
      static CLOSED = 3;

      constructor(url: string) {
        throw new Error(`failed to connect ${url}`);
      }
    }

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-must-not-leak",
    }));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus, {
      WebSocketImpl: ThrowingWebSocket as any,
      reconnectDelayMs: 60_000,
    });

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("[redacted]"),
    ));
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("ticket-must-not-leak");

    adapter.stop();
  });

  it("rejects custom robot webhook credentials for the Enterprise Stream connector", () => {
    const fetchMock = vi.fn();

    expect(() => makeAdapter(fetchMock, vi.fn(), vi.fn(), {
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=custom",
      webhookSecret: "custom-secret",
    })).toThrow(/custom robot webhook fields/i);
  });

  it("splits long replies before sending DingTalk markdown payloads", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-1" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-2" }));
    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "你".repeat(5000), { targetScope: "dm" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const first = JSON.parse(JSON.parse(fetchMock.mock.calls[2][1].body).msgParam);
    const second = JSON.parse(JSON.parse(fetchMock.mock.calls[3][1].body).msgParam);
    expect(first.title).toBe("Hana 1/2");
    expect(second.title).toBe("Hana 2/2");
    expect(first.text + second.text).toBe("你".repeat(5000));

    adapter.stop();
  });

  it("declares batch text streaming only after the final message is ready", () => {
    expect(DINGTALK_STREAMING_CAPABILITIES).toMatchObject({
      platform: "dingtalk",
      mode: "batch",
      scopes: ["dm", "group"],
      renderer: "text",
    });
  });
});
