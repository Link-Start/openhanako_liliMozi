import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCONNECT_ABORT_GRACE_MS,
  createChatRoute,
  resolveDisconnectAbortGraceMs,
} from "../server/routes/chat.ts";
import { TURN_INPUT_CONSUMPTION_EVENT_TYPE } from "../lib/turn-input-presentation.ts";

describe("chat route model switch guard", () => {
  it("uses a minute-scale default WS disconnect abort grace and allows disabling it", () => {
    expect(DEFAULT_DISCONNECT_ABORT_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(resolveDisconnectAbortGraceMs(undefined)).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("0")).toBe(0);
    expect(resolveDisconnectAbortGraceMs("45000")).toBe(45_000);
    expect(resolveDisconnectAbortGraceMs("-1")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("bad")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
  });

  it("rejects prompts through the engine public switching API", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => true),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        sessionPath: "/tmp/session.jsonl",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(hub.send).not.toHaveBeenCalled();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      message: "正在切换模型，请稍候",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("routes streaming interject messages through the desktop interjection contract", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      ensureSessionLoaded: vi.fn(async () => ({})),
      emitEvent: vi.fn(),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      setUiContext: vi.fn(),
      steerSession: vi.fn(() => true),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "interject",
        text: "插一句",
        sessionPath: "/tmp/session.jsonl",
        displayMessage: { text: "插一句" },
        uiContext: { currentTab: "chat" },
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    expect(engine.steerSession).toHaveBeenCalledWith("/tmp/session.jsonl", "插一句");
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "插一句" }),
      }),
      "/tmp/session.jsonl",
    );
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "steered",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("keeps shared stream state attached to the session id when the session path moves", () => {
    let createHandlers;
    let subscriber;
    const originalPath = "/tmp/original-stream.jsonl";
    const movedPath = "/tmp/archived/renamed-stream.jsonl";
    const sessionId = "sess_chat_stream";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionIdForPath: vi.fn((sessionPath) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      )),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "一" },
    }, originalPath);
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "二" },
    }, movedPath);

    const deltas = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "text_delta");

    expect(deltas.map((payload) => payload.seq)).toEqual([1, 2]);
    expect(deltas[1]).toMatchObject({
      sessionPath: movedPath,
      streamId: deltas[0].streamId,
    });

    handlers.onClose({}, ws);
  });

  it("renders structured reasoning_content thinking deltas from OpenAI-compatible providers", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        reasoning_content: "先判断 DeepSeek 的结构化推理字段。",
      },
    }, "/tmp/deepseek-thinking.jsonl");

    const thinkingEvents = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "thinking_start" || payload.type === "thinking_delta");

    expect(thinkingEvents).toEqual([
      expect.objectContaining({ type: "thinking_start" }),
      expect.objectContaining({
        type: "thinking_delta",
        delta: "先判断 DeepSeek 的结构化推理字段。",
      }),
    ]);

    handlers.onClose({}, ws);
  });

  it("buffers OpenAI Responses text until text_end and suppresses commentary phase", () => {
    let createHandlers;
    let subscriber;
    const commentarySignature = JSON.stringify({
      v: 1,
      id: "msg_commentary",
      phase: "commentary",
    });
    const finalSignature = JSON.stringify({
      v: 1,
      id: "msg_final",
      phase: "final_answer",
    });
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    const sessionPath = "/tmp/openai-phase-session.jsonl";
    const commentaryPartial = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      content: [{ type: "text", text: "I need to inspect the current state." }],
    };
    const finalContent = [
      {
        type: "text",
        text: "I need to inspect the current state.",
        textSignature: commentarySignature,
      },
      {
        type: "text",
        text: "已经查到状态。",
        textSignature: finalSignature,
      },
    ];

    subscriber?.({
      type: "message_update",
      message: commentaryPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "I need to inspect the current state.",
        partial: commentaryPartial,
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: [finalContent[0]] },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "I need to inspect the current state.",
        partial: { ...commentaryPartial, content: [finalContent[0]] },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: finalContent },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "已经查到状态。",
        partial: { ...commentaryPartial, content: finalContent },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: finalContent },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        content: "已经查到状态。",
        partial: { ...commentaryPartial, content: finalContent },
      },
    }, sessionPath);

    const deltas = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "text_delta");

    expect(deltas.map((payload) => payload.delta)).toEqual(["已经查到状态。"]);

    handlers.onClose({}, ws);
  });

  it("reports engine runtime streaming separately when resume replay state is missing", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionIdForPath: vi.fn(() => "sess_running"),
      isSessionStreaming: vi.fn((sessionPath) => sessionPath === "/tmp/running-session.jsonl"),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    handlers.onOpen({}, ws);

    handlers.onMessage({
      data: JSON.stringify({
        type: "resume_stream",
        sessionPath: "/tmp/running-session.jsonl",
        sessionId: "sess_running",
        sinceSeq: 42,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionStreaming).toHaveBeenCalledWith("/tmp/running-session.jsonl");
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "stream_resume",
      sessionPath: "/tmp/running-session.jsonl",
      sessionId: "sess_running",
      sessionRefVersion: 2,
      streamId: null,
      sinceSeq: 42,
      nextSeq: 1,
      isStreaming: false,
      runtimeIsStreaming: true,
      events: [],
    });

    handlers.onClose({}, ws);
  });

  it("includes the active streamId on status start and finish messages", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/identity-session.jsonl");
    subscriber?.({ type: "session_status", isStreaming: false }, "/tmp/identity-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const start = payloads.find((payload) => payload.type === "status" && payload.isStreaming === true);
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(start).toMatchObject({
      type: "status",
      sessionPath: "/tmp/identity-session.jsonl",
      isStreaming: true,
    });
    expect(start.streamId).toEqual(expect.any(String));
    expect(start.streamId.length).toBeGreaterThan(0);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/identity-session.jsonl",
      isStreaming: false,
      streamId: start.streamId,
    });

    handlers.onClose({}, ws);
  });

  it("preserves abort metadata on session status broadcasts", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/reason-session.jsonl");
    subscriber?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason: "turn_stall_timeout",
    }, "/tmp/reason-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/reason-session.jsonl",
      isStreaming: false,
      aborted: true,
      reason: "turn_stall_timeout",
    });

    handlers.onClose({}, ws);
  });

  it("keeps remote and host clients on the same server-side session stream", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const hostWs = { readyState: 1, send: vi.fn() };
    const phoneWs = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, hostWs);
    handlers.onOpen({}, phoneWs);

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello from phone",
        sessionPath: "/tmp/shared-session.jsonl",
        clientMessageId: "client-user-1",
      }),
    }, phoneWs);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledWith("hello from phone", expect.objectContaining({
      sessionPath: "/tmp/shared-session.jsonl",
      clientMessageId: "client-user-1",
    }));

    subscriber?.({
      type: "session_user_message",
      clientMessageId: "client-user-1",
      message: { id: "u1", text: "hello from phone" },
    }, "/tmp/shared-session.jsonl");

    for (const ws of [hostWs, phoneWs]) {
      expect(ws.send).toHaveBeenCalledWith(expect.any(String));
      const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(payloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "session_user_message",
          sessionPath: "/tmp/shared-session.jsonl",
          clientMessageId: "client-user-1",
          message: { id: "u1", text: "hello from phone" },
        }),
      ]));
    }

    handlers.onClose({}, hostWs);
    handlers.onClose({}, phoneWs);
  });

  it("emits file content blocks for deferred result session files", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "deferred_result",
      taskId: "img-task-1",
      status: "success",
      result: {
        files: ["abc.png"],
        sessionFiles: [{
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }],
      },
      meta: { type: "image-generation" },
    }, "/tmp/image-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "deferred_result",
        sessionPath: "/tmp/image-session.jsonl",
        taskId: "img-task-1",
        status: "success",
      }),
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/image-session.jsonl",
        block: expect.objectContaining({
          type: "file",
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }),
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("renders deferred interludes only when the actual hidden custom message is consumed", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "回来了。",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "凌晨诗行",
            summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      recordCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/interlude-session.jsonl");
    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "派出去了。\n" },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "deferred_result",
      taskId: "subagent-fast",
      status: "success",
      result: "回来了。",
      meta: {
        type: "subagent",
        interlude: true,
        executorAgentNameSnapshot: "Hanako",
        label: "凌晨诗行",
        summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
      },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "turn_input_presentation",
      presentation: {
        kind: "pre_reply_interlude",
        deliveryId: "delivery-subagent-fast",
        taskId: "subagent-fast",
        status: "success",
        resultType: "subagent",
        result: "回来了。",
        deliveryMode: "followUp",
      },
    }, "/tmp/interlude-session.jsonl");

    let payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "deferred_result")).toBe(true);
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);

    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const turnEndIndex = payloads.findIndex((payload) => payload.type === "turn_end");
    expect(turnEndIndex).toBeGreaterThanOrEqual(0);
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);

    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "这不是后台结果回复。\n" },
    }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);
    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");
    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-subagent-fast",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"subagent-fast\" status=\"success\" type=\"subagent\">\n回来了。\n</hana-background-result>",
        details: { deliveryId: "delivery-subagent-fast" },
      },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-subagent-fast", parentId: "custom-subagent-fast", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "收到，正在处理。\n" },
    }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const interludeIndex = payloads.findIndex((payload) => payload.type === "content_block" && payload.block?.type === "interlude");
    const nextTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "收到，正在处理。\n");
    expect(interludeIndex).toBeGreaterThan(turnEndIndex);
    expect(interludeIndex).toBeLessThan(nextTextIndex);
    expect(payloads[interludeIndex].block).toMatchObject({
      type: "interlude",
      taskId: "subagent-fast",
      deliveryId: "delivery-subagent-fast",
      sourceLabel: "Hanako · 凌晨诗行",
    });
    expect(engine.recordCustomEntry).toHaveBeenCalledWith(
      "/tmp/interlude-session.jsonl",
      TURN_INPUT_CONSUMPTION_EVENT_TYPE,
      expect.objectContaining({
        schemaVersion: 1,
        input: expect.objectContaining({
          entryId: "custom-subagent-fast",
          customType: "hana-background-result",
          deliveryId: "delivery-subagent-fast",
          taskId: "subagent-fast",
        }),
        assistant: expect.objectContaining({
          entryId: "assistant-subagent-fast",
          parentId: "custom-subagent-fast",
        }),
        block: expect.objectContaining({
          type: "interlude",
          deliveryId: "delivery-subagent-fast",
          taskId: "subagent-fast",
        }),
      }),
    );

    handlers.onClose({}, ws);
  });

  it("does not render successful media-generation custom inputs as deferred interludes", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/media-custom-input-session.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: { sessionFiles: [{ filePath: "/tmp/generated/abc.png" }] },
          meta: { type: "image-generation" },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      recordCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-image-success",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-img\" status=\"success\" type=\"image-generation\">\n{\"sessionFiles\":[{\"filePath\":\"/tmp/generated/abc.png\"}]}\n</hana-background-result>",
        details: { deliveryId: "delivery-image-success" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-after-image", parentId: "custom-image-success", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "图片生成完成。" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);
    expect(payloads.some((payload) => payload.type === "text_delta" && payload.delta === "图片生成完成。")).toBe(true);
    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    handlers.onClose({}, ws);
  });

  it("orders deferred interludes by actual custom-message consumption order", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-followup-one-by-one.jsonl";
    const taskMeta: Record<string, { label: string; summary: string }> = {
      "task-a": { label: "A", summary: "first task" },
      "task-b": { label: "B", summary: "second task" },
    };
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn((taskId) => ({
          status: "resolved",
          result: `${taskId} done`,
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: taskMeta[taskId]?.label,
            summary: taskMeta[taskId]?.summary,
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "one-at-a-time" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-b", "task-a"]) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-${taskId}`,
          taskId,
          status: "success",
          resultType: "subagent",
          result: `${taskId} done`,
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ntask-a done\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a", parentId: "custom-task-a", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "first follow-up reply" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-b",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-b\" status=\"success\" type=\"subagent\">\ntask-b done\n</hana-background-result>",
        details: { deliveryId: "delivery-task-b" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-b", parentId: "custom-task-b", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "second follow-up reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const firstTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "first follow-up reply");
    const secondTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "second follow-up reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes).toHaveLength(2);
    expect(interludes[0].payload.block.taskId).toBe("task-a");
    expect(interludes[0].index).toBeLessThan(firstTextIndex);
    expect(interludes[1].payload.block.taskId).toBe("task-b");
    expect(interludes[1].index).toBeGreaterThan(firstTextIndex);
    expect(interludes[1].index).toBeLessThan(secondTextIndex);

    handlers.onClose({}, ws);
  });

  it("keeps repeated consumed custom messages for the same task as distinct interludes", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-repeated-task.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "same task result",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "same-task",
            summary: "same task delivered twice",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "one-at-a-time" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (let i = 0; i < 2; i += 1) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-task-a-${i}`,
          taskId: "task-a",
          status: "success",
          resultType: "subagent",
          result: "same task result",
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a-0",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\nsame task result\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a-0" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a-0", parentId: "custom-task-a-0", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "first repeated delivery reply" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a-1",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\nsame task result\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a-1" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a-1", parentId: "custom-task-a-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "second repeated delivery reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const firstTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "first repeated delivery reply");
    const secondTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "second repeated delivery reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes).toHaveLength(2);
    expect(interludes.map(({ payload }) => payload.block.taskId)).toEqual(["task-a", "task-a"]);
    expect(new Set(interludes.map(({ payload }) => payload.block.id)).size).toBe(2);
    expect(interludes[0].index).toBeLessThan(firstTextIndex);
    expect(interludes[1].index).toBeGreaterThan(firstTextIndex);
    expect(interludes[1].index).toBeLessThan(secondTextIndex);

    handlers.onClose({}, ws);
  });

  it("persists a turn input consumption record only when the consumed custom input receives an assistant reply", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-persist-on-consume.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "done",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "queued-task",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "one-at-a-time" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      recordCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "turn_input_presentation",
      presentation: {
        kind: "pre_reply_interlude",
        deliveryId: "delivery-consumed-later",
        taskId: "task-a",
        status: "success",
        resultType: "subagent",
        result: "done",
        deliveryMode: "followUp",
      },
    }, sessionPath);

    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, sessionPath);
    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-unrelated", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "unrelated reply" },
    }, sessionPath);
    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-consumed-later",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ndone\n</hana-background-result>",
        details: { deliveryId: "delivery-consumed-later" },
      },
    }, sessionPath);
    expect(engine.recordCustomEntry).not.toHaveBeenCalled();

    subscriber?.({
      type: "message_update",
      message: { id: "assistant-consumes-task-a", parentId: "custom-consumed-later", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "收到 task-a" },
    }, sessionPath);

    expect(engine.recordCustomEntry).toHaveBeenCalledTimes(1);
    expect(engine.recordCustomEntry).toHaveBeenCalledWith(
      sessionPath,
      TURN_INPUT_CONSUMPTION_EVENT_TYPE,
      expect.objectContaining({
        schemaVersion: 1,
        deliveryId: "delivery-consumed-later",
        input: expect.objectContaining({
          entryId: "custom-consumed-later",
          customType: "hana-background-result",
          taskId: "task-a",
          deliveryId: "delivery-consumed-later",
        }),
        assistant: expect.objectContaining({
          entryId: "assistant-consumes-task-a",
          parentId: "custom-consumed-later",
        }),
        block: expect.objectContaining({
          type: "interlude",
          deliveryId: "delivery-consumed-later",
          taskId: "task-a",
        }),
      }),
    );

    handlers.onClose({}, ws);
  });

  it("renders consecutive consumed custom messages before the assistant reply that consumes them", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-followup-all.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn((taskId) => ({
          status: "resolved",
          result: `${taskId} done`,
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: taskId,
            summary: taskId,
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "all" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-a", "task-b"]) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-${taskId}`,
          taskId,
          status: "success",
          resultType: "subagent",
          result: `${taskId} done`,
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-a", "task-b"]) {
      subscriber?.({
        type: "message_end",
        message: {
          id: `custom-${taskId}`,
          role: "custom",
          customType: "hana-background-result",
          display: false,
          content: `<hana-background-result task-id="${taskId}" status="success" type="subagent">\n${taskId} done\n</hana-background-result>`,
          details: { deliveryId: `delivery-${taskId}` },
        },
      }, sessionPath);
    }
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-combined", parentId: "custom-task-b", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "combined follow-up reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const textIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "combined follow-up reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes.map(({ payload }) => payload.block.taskId)).toEqual(["task-a", "task-b"]);
    expect(interludes.every(({ index }) => index < textIndex)).toBe(true);

    handlers.onClose({}, ws);
  });

  it("delivers a turn completion desktop notification when the preference is enabled", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/notified-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/notified-session.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/notified-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        body: expect.any(String),
        channels: ["desktop"],
        desktopFocusPolicy: "when_unfocused",
        idempotencyKey: expect.stringContaining("turn-completion:/tmp/notified-session.jsonl:"),
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("delivers a session-aware turn completion notification with the completed sessionPath", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_session_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/session-aware.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/session-aware.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/session-aware.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        sessionPath: "/tmp/session-aware.jsonl",
        desktopFocusPolicy: "when_session_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("defers turn completion notifications until the session is no longer streaming", async () => {
    let createHandlers;
    let subscriber;
    let runtimeStreaming = true;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => runtimeStreaming),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/deferred-notification.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "工具前输出。" },
    }, "/tmp/deferred-notification.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    runtimeStreaming = false;
    subscriber?.({ type: "session_status", isStreaming: false }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        sessionPath: "/tmp/deferred-notification.jsonl",
        desktopFocusPolicy: "when_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("does not deliver turn completion notification after an aborted turn", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ turnCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({ entries: [], agentId: "agent-2", agentName: "小蓝" })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/aborted-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "一半" },
    }, "/tmp/aborted-session.jsonl");
    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/aborted-session.jsonl" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscriber?.({ type: "turn_end" }, "/tmp/aborted-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    handlers.onClose({}, ws);
  });

  it("aborts a streaming session only after the turn has been idle past the stall timeout", async () => {
    vi.useFakeTimers();
    const prevTimeout = process.env.HANA_TURN_STALL_ABORT_MS;
    process.env.HANA_TURN_STALL_ABORT_MS = "100";
    try {
      let createHandlers;
      let subscriber;
      const upgradeWebSocket = vi.fn((factory) => {
        createHandlers = factory;
        return () => new Response(null);
      });
      const hub = {
        subscribe: vi.fn((fn) => {
          subscriber = fn;
        }),
        send: vi.fn(async () => {}),
        abort: vi.fn(async () => true),
      };
      const engine = {
        agentName: "Hana",
        abortAllStreaming: vi.fn(async () => {}),
        getNotificationPreferences: vi.fn(() => ({ turnCompletion: "never" })),
        getSessionByPath: vi.fn(() => ({ entries: [] })),
        isSessionStreaming: vi.fn(() => true),
        isSessionSwitching: vi.fn(() => false),
        steerSession: vi.fn(() => false),
        slashDispatcher: null,
      };

      createChatRoute(engine, hub, { upgradeWebSocket });
      const handlers = createHandlers({});
      const ws = { readyState: 1, send: vi.fn() };
      handlers.onOpen({}, ws);

      subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/stall-watchdog.jsonl");
      vi.advanceTimersByTime(90);
      expect(hub.abort).not.toHaveBeenCalled();

      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "还在输出" },
      }, "/tmp/stall-watchdog.jsonl");
      vi.advanceTimersByTime(90);
      expect(hub.abort).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      await Promise.resolve();
      expect(hub.abort).toHaveBeenCalledWith("/tmp/stall-watchdog.jsonl", {
        reason: "turn_stall_timeout",
      });

      handlers.onClose({}, ws);
    } finally {
      if (prevTimeout === undefined) delete process.env.HANA_TURN_STALL_ABORT_MS;
      else process.env.HANA_TURN_STALL_ABORT_MS = prevTimeout;
      vi.useRealTimers();
    }
  });

  it("passes a user abort reason through the websocket stop path", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => false),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/user-abort.jsonl");
    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/user-abort.jsonl" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.abort).toHaveBeenCalledWith("/tmp/user-abort.jsonl", { reason: "user_abort" });
    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/user-abort.jsonl",
      isStreaming: false,
      aborted: true,
      reason: "user_abort",
    });

    handlers.onClose({}, ws);
  });

  it("does not render interludes directly from standalone deferred result notifications", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    for (const taskId of ["standalone-1", "standalone-2"]) {
      subscriber?.({
        type: "deferred_result",
        taskId,
        status: "success",
        result: `result ${taskId}`,
        meta: { type: "subagent", interlude: true, executorAgentNameSnapshot: "明", label: "回执" },
      }, "/tmp/standalone-deferred.jsonl");
    }

    const interludeTaskIds = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "content_block" && payload.block?.type === "interlude")
      .map((payload) => payload.block.taskId);

    expect(interludeTaskIds).toEqual([]);

    handlers.onClose({}, ws);
  });

  it("emits plugin_card blocks from extension custom messages", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "finance-market",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
          },
        },
      },
    }, "/tmp/plugin-card-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/plugin-card-session.jsonl",
        block: {
          type: "plugin_card",
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
            type: "iframe",
          },
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("normalizes live plugin chat surface blocks before broadcasting", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_tavern"
        ? {
          sessionId,
          currentLocator: { path: "/tmp/plugin-owned-current.jsonl" },
          plugin: { ownerPluginId: "tavern", visibility: "private" },
        }
        : null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "tavern",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "tavern",
            type: "chat.surface",
            sessionId: "sess_tavern",
            title: "Tavern run",
          },
        },
      },
    }, "/tmp/root-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/root-session.jsonl",
        block: {
          type: "plugin_card",
          card: {
            pluginId: "tavern",
            type: "chat.surface",
            sessionId: "sess_tavern",
            sessionPath: "/tmp/plugin-owned-current.jsonl",
            sessionRef: {
              sessionId: "sess_tavern",
              sessionPath: "/tmp/plugin-owned-current.jsonl",
            },
            title: "Tavern run",
          },
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts browser_status events emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "browser_status",
      running: false,
      url: null,
    }, "/tmp/browser-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "browser_status",
        running: false,
        url: null,
        sessionPath: "/tmp/browser-session.jsonl",
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts session metadata updates emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "session_metadata_updated",
      metadata: { pinnedAt: "2026-04-29T08:00:00.000Z", thinkingLevel: "high" },
    }, "/tmp/metadata-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session_metadata_updated",
        sessionPath: "/tmp/metadata-session.jsonl",
        metadata: {
          pinnedAt: "2026-04-29T08:00:00.000Z",
          thinkingLevel: "high",
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("does not serialize broadcast payloads for closed clients", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const closedWs = { readyState: 3, send: vi.fn() };
    handlers.onOpen({}, closedWs);

    const toxicSession = {
      toJSON() {
        throw new Error("closed clients must not force serialization");
      },
    };

    expect(() => {
      subscriber?.({
        type: "session_created",
        session: toxicSession,
      }, "/tmp/closed-client-session.jsonl");
    }).not.toThrow();
    expect(closedWs.send).not.toHaveBeenCalled();

    handlers.onClose({}, closedWs);
  });
});
