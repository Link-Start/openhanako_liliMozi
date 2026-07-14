import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeSimpleMock,
  convertAgentMessagesToLlmMock,
  estimateTokensMock,
  findCutPointMock,
  prepareCompactionMock,
} = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  convertAgentMessagesToLlmMock: vi.fn(async (messages) => messages),
  estimateTokensMock: vi.fn((message) => {
    const content = Array.isArray(message?.content)
      ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
      : String(message?.content || message?.summary || "");
    return Math.ceil(content.length / 4);
  }),
  findCutPointMock: vi.fn(() => ({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false })),
  prepareCompactionMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  completeSimple: completeSimpleMock,
  convertAgentMessagesToLlm: convertAgentMessagesToLlmMock,
  estimateTokens: estimateTokensMock,
  findCutPoint: findCutPointMock,
  prepareCompaction: prepareCompactionMock,
}));

import {
  appendCompactionResultToSession,
  compactSessionWithCachePreservation,
  compactSessionWithCachePreservationRecoveringRuntime,
  createCachePreservingCompactionResult,
  normalizeCompactionProviderPayload,
  runCachePreservingCompactionForSession,
} from "../core/session-compactor.ts";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";
import { runSessionSnapshotSideTask } from "../lib/llm/session-snapshot-side-task-runner.ts";

describe("session-compactor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertAgentMessagesToLlmMock.mockImplementation(async (messages) => messages);
    estimateTokensMock.mockImplementation((message) => {
      const content = Array.isArray(message?.content)
        ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
        : String(message?.content || message?.summary || "");
      return Math.ceil(content.length / 4);
    });
    findCutPointMock.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("uses Pi compaction boundaries and prompt text while moving the prompt after the cached prefix", async () => {
    const signal = new AbortController().signal;
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
      })),
    };
    const streamFn = vi.fn(async () => resultStream);
    const convertToLlm = vi.fn(async (messages) => messages);

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        previousSummary: "previous checkpoint",
        messagesToSummarize: [
          { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
        ],
        settings: { reserveTokens: 1000 },
        fileOps: {
          read: new Set(["/tmp/read.md", "/tmp/edited.md"]),
          written: new Set(["/tmp/written.md"]),
          edited: new Set(["/tmp/edited.md"]),
        },
      },
      model: { id: "model", reasoning: true },
      systemPrompt: "agent system prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY" }], timestamp: 2 },
      ],
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      customInstructions: "focus on decisions",
      signal,
      thinkingLevel: "high",
      outputPolicy: "bounded",
      streamFn,
      convertToLlm,
    } as any);

    expect(convertToLlm).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledOnce();
    const [model, context, options] = (streamFn.mock.calls as any)[0];
    expect(model).toEqual({ id: "model", reasoning: true });
    expect(context!.systemPrompt).toBe("agent system prompt");
    expect(context!.tools).toEqual([
      { name: "read", description: "Read files", parameters: { type: "object" } },
    ]);
    expect(context!.messages).toHaveLength(2);
    expect(context!.messages[0].content[0].text).toBe("old history to summarize");
    expect(JSON.stringify(context!.messages)).not.toContain("KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY");
    expect(context!.messages[1].role).toBe("user");
    expect(context!.messages[1].content[0].text).toContain("<previous-summary>\nprevious checkpoint\n</previous-summary>");
    expect(context!.messages[1].content[0].text).toContain("The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.");
    expect(context!.messages[1].content[0].text).toContain("Additional focus: focus on decisions");
    expect(context!.messages[1].content[0].text).not.toContain("Hana cache-preserving compaction");
    expect(options).toEqual(expect.objectContaining({
      maxTokens: 800,
      reasoning: "high",
      signal,
      toolChoice: "none",
    }));

    expect(result).toEqual({
      summary: [
        "checkpoint summary",
        "",
        "<read-files>",
        "/tmp/read.md",
        "</read-files>",
        "",
        "<modified-files>",
        "/tmp/edited.md",
        "/tmp/written.md",
        "</modified-files>",
      ].join("\n"),
      firstKeptEntryId: "entry-keep",
      tokensBefore: 1234,
      details: {
        readFiles: ["/tmp/read.md"],
        modifiedFiles: ["/tmp/edited.md", "/tmp/written.md"],
      },
    });
  });

  it("uses provider-default output for reasoning compaction without a Hana numeric cap", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "reasoning that does not consume a Hana summary cap" },
          { type: "text", text: "complete summary" },
        ],
      })),
    }));

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: [{ role: "user", content: "history" }],
        settings: { reserveTokens: 1000 },
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        maxTokens: 64_000,
        contextWindow: 128_000,
      },
      systemPrompt: "system prompt",
      thinkingLevel: "high",
      outputPolicy: "provider-default",
      streamFn,
      convertToLlm: vi.fn(async (messages) => messages),
    } as any);

    expect(result.summary).toBe("complete summary");
    const [, , options] = streamFn.mock.calls[0] as any;
    expect(options).toMatchObject({ reasoning: "high", toolChoice: "none" });
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("normalizes provider-default and bounded compaction payloads without changing global chat policy", () => {
    const model = {
      id: "deepseek-reasoner",
      provider: "deepseek",
      api: "openai-completions",
      reasoning: true,
      maxTokens: 64_000,
      contextWindow: 128_000,
    };
    const payload = {
      model: model.id,
      messages: [{ role: "user", content: "summarize" }],
      max_tokens: 800,
      reasoning_effort: "auto",
    };

    const providerDefault = normalizeCompactionProviderPayload(payload, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    });
    expect(providerDefault).toMatchObject({
      model: model.id,
      messages: payload.messages,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(providerDefault).not.toHaveProperty("max_tokens");
    expect(normalizeCompactionProviderPayload({
      model: "summary-model",
      messages: payload.messages,
      max_tokens: 800,
    }, {
      id: "summary-model",
      provider: "custom",
      api: "openai-completions",
      reasoning: false,
      maxTokens: 16_000,
      contextWindow: 128_000,
    }, {
      outputPolicy: "bounded",
      boundedMaxTokens: 800,
      reasoningLevel: "off",
    })).toMatchObject({ max_tokens: 800 });
  });

  it("synthesizes a safe cap when a provider protocol requires one", () => {
    const model = {
      id: "claude-sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 64_000,
      contextWindow: 128_000,
    };

    expect(normalizeCompactionProviderPayload({ messages: [] }, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    })).toMatchObject({ max_tokens: 64_000 });
    expect(normalizeCompactionProviderPayload({ messages: [], max_tokens: 0 }, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    })).toMatchObject({ max_tokens: 64_000 });
  });

  it("records cache-preserving compaction usage in the usage ledger", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "compact-usage-1" });
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 80,
        },
      })),
    };

    await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        settings: { reserveTokens: 1000 },
      },
      model: {
        id: "gpt-5",
        provider: "openai",
        api: "openai-responses",
        reasoning: false,
      },
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      streamFn: vi.fn(async () => resultStream),
      convertToLlm: vi.fn(async (messages) => messages),
      usageLedger: ledger,
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "desktop",
          trigger: "overflow",
        },
        attribution: {
          kind: "session",
          agentId: "agent-1",
          sessionPath: "/sessions/current.jsonl",
        },
      },
    } as any);

    const [entry] = ledger.list({ subsystem: "compaction" }).entries;
    expect(entry).toMatchObject({
      requestId: "compact-usage-1",
      status: "ok",
      source: { subsystem: "compaction", operation: "compact" },
      attribution: { kind: "session", sessionPath: "/sessions/current.jsonl" },
      model: { provider: "openai", modelId: "gpt-5", api: "openai-responses" },
      usage: {
        input: { totalTokens: 100, uncachedTokens: 20 },
        output: { totalTokens: 25 },
        cache: { readTokens: 80, hit: true },
      },
    });
    expect(entry.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      cacheGroup: "compaction.history",
      strict: true,
    });
  });

  it("uses supplied session snapshot cache params as the strict side-task contract", async () => {
    const messages = [{ role: "user", content: "history before compaction" }];
    const model = {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
    };
    const sessionSnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/current.jsonl",
      reason: "compaction.history",
      model,
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "system prompt",
      tools: [],
      messages,
    });
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "cache summary" }],
      })),
    }));

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: messages,
        settings: { reserveTokens: 1000 },
      },
      model,
      systemPrompt: "system prompt",
      messages,
      sessionSnapshot,
      cacheKeyParams: { thinkingLevel: "off" },
      thinkingLevel: "off",
      streamFn,
      convertToLlm: vi.fn(async (input) => input),
    } as any);

    expect(result.summary).toBe("cache summary");
    expect((streamFn.mock.calls as any)[0][2]).toMatchObject({
      reasoning: "medium",
      toolChoice: "none",
    });
  });

  it("projects MCP resource content before cache-preserving compaction provider calls", async () => {
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "resource summary" }],
      })),
    };
    const streamFn = vi.fn(async () => resultStream);
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "file:///workspace/spec.md",
        name: "spec.md",
        mimeType: "text/markdown",
        text: "Compaction must keep this visible.",
      },
    };

    await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: [
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read_resource",
            content: [resourceBlock],
          },
        ],
        settings: { reserveTokens: 1000 },
      },
      model: { id: "gpt-5", provider: "openai", api: "openai-responses", reasoning: false },
      systemPrompt: "system prompt",
      streamFn,
      convertToLlm: vi.fn(async (messages) => messages),
    } as any);

    const [, context] = streamFn.mock.calls[0] as any;
    const projected = context.messages[0].content[0];
    expect(projected.type).toBe("text");
    expect(projected.text).toContain("uri: file:///workspace/spec.md");
    expect(projected.text).toContain("name: spec.md");
    expect(projected.text).toContain("mimeType: text/markdown");
    expect(projected.text).toContain("Compaction must keep this visible.");
    expect(resourceBlock.resource.text).toBe("Compaction must keep this visible.");
  });

  it("writes cache-preserving compaction results back into the session branch", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      messagesToSummarize: [{ role: "user", content: "before compaction" }],
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const replaceMessages = vi.fn();
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        transformContext: vi.fn(async (messages) => [
          ...messages,
          { role: "assistant", content: "latest streamed answer" },
        ]),
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages,
      },
    };

    const onCompacted = vi.fn();
    const result = await runCachePreservingCompactionForSession(session, { onCompacted });

    expect(prepareCompactionMock).toHaveBeenCalledWith(branch, { enabled: true, reserveTokens: 2000 });
    expect(session.agent.transformContext).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      "cache summary",
      "entry-keep",
      4321,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(onCompacted).toHaveBeenCalledOnce();
    expect(onCompacted).toHaveBeenCalledWith(session);
    expect(result.summary).toBe("cache summary");
  });

  it("hard truncates direct session compaction when the cache-preserving request cannot fit", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: { role: "user", content: "old " + "x".repeat(2000) } },
      { type: "message", id: "entry-keep", message: { role: "assistant", content: [{ type: "text", text: "keep" }] } },
    ];
    const compactedMessages = [{ role: "compactionSummary", summary: "truncated" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const replaceMessages = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "tiny", reasoning: false, contextWindow: 1000 },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system " + "x".repeat(2000),
          messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(6000) }] }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages,
      },
    };

    const onCompacted = vi.fn();
    const result = await runCachePreservingCompactionForSession(session, { onCompacted });

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(onCompacted).toHaveBeenCalledWith(session);
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("calls onCompacted only after append, message replacement, and compact event succeed", async () => {
    const order: string[] = [];
    const onCompacted = vi.fn(() => order.push("callback"));
    const session = {
      sessionManager: {
        appendCompaction: vi.fn(() => {
          order.push("append");
          return "compaction-entry";
        }),
        buildSessionContext: vi.fn(() => ({ messages: [{ role: "compactionSummary", summary: "done" }] })),
        getEntry: vi.fn(() => ({ id: "compaction-entry", type: "compaction" })),
      },
      agent: {
        replaceMessages: vi.fn(() => order.push("replace")),
      },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { order.push("event"); }),
      },
    };
    const result = {
      summary: "done",
      firstKeptEntryId: "keep",
      tokensBefore: 12,
      details: {},
    };

    await appendCompactionResultToSession(session, result, { onCompacted });

    expect(order).toEqual(["append", "replace", "event", "callback"]);
  });

  it("does not call onCompacted when replacement or compact event fails", async () => {
    const result = {
      summary: "done",
      firstKeptEntryId: "keep",
      tokensBefore: 12,
      details: {},
    };
    const onReplaceFailure = vi.fn();
    const replaceFailure = {
      sessionManager: {
        appendCompaction: vi.fn(() => "entry"),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
      },
      agent: { replaceMessages: vi.fn(() => { throw new Error("replace failed"); }) },
    };
    await expect(appendCompactionResultToSession(replaceFailure, result, {
      onCompacted: onReplaceFailure,
    })).rejects.toThrow("replace failed");
    expect(onReplaceFailure).not.toHaveBeenCalled();

    const onEventFailure = vi.fn();
    const eventFailure = {
      sessionManager: {
        appendCompaction: vi.fn(() => "entry"),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getEntry: vi.fn(() => ({ id: "entry", type: "compaction" })),
      },
      agent: { replaceMessages: vi.fn() },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { throw new Error("event failed"); }),
      },
    };
    await expect(appendCompactionResultToSession(eventFailure, result, {
      onCompacted: onEventFailure,
    })).rejects.toThrow("event failed");
    expect(onEventFailure).not.toHaveBeenCalled();
  });

  it("hard truncates direct session compaction when model context window is unknown", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: { role: "user", content: "old context" } },
      { type: "message", id: "entry-keep", message: { role: "assistant", content: "keep" } },
    ];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "missing-window", reasoning: false },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: [{ role: "compactionSummary", summary: "truncated" }] })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages: vi.fn(),
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("emits lifecycle events for direct model-switch compaction", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn(() => "compaction-entry");
    const emit = vi.fn();
    const extensionEmit = vi.fn(async () => {});
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      _emit: emit,
      extensionRunner: {
        hasHandlers: vi.fn((event) => event === "session_compact"),
        emit: extensionEmit,
      },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        getEntry: vi.fn(() => ({ type: "compaction", id: "compaction-entry", summary: "cache summary" })),
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages: vi.fn(),
      },
    };

    await runCachePreservingCompactionForSession(session, {
      emitLifecycle: true,
      lifecycleReason: "model_switch",
    });

    expect(emit).toHaveBeenNthCalledWith(1, { type: "compaction_start", reason: "model_switch" });
    expect(extensionEmit).toHaveBeenCalledWith({
      type: "session_compact",
      compactionEntry: { type: "compaction", id: "compaction-entry", summary: "cache summary" },
      fromExtension: true,
    });
    expect(emit).toHaveBeenLastCalledWith({
      type: "compaction_end",
      reason: "model_switch",
      result: expect.objectContaining({ summary: "cache summary" }),
      aborted: false,
      willRetry: false,
    });
  });

  it("refuses the manual wrapper when the compaction hook is missing", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };

    await expect((compactSessionWithCachePreservation as any)(session)).rejects.toThrow(
      "Cache-preserving compaction extension is not installed",
    );
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("reloads the session runtime once when the compaction hook is missing", async () => {
    const staleSession = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    const reloadedSession = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn((event) => event === "session_before_compact") },
    };
    const reloadSessionRuntime = vi.fn(async () => reloadedSession);

    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: staleSession,
      sessionPath: "/sessions/a.jsonl",
      customInstructions: "focus",
      reloadSessionRuntime,
    })).resolves.toMatchObject({ result: "ok", session: reloadedSession, recovered: true });

    expect(staleSession.compact).not.toHaveBeenCalled();
    expect(reloadSessionRuntime).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(reloadedSession.compact).toHaveBeenCalledWith("focus");
  });

  it("reports stale extension runners before invoking manual compaction", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(() => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        }),
        hasHandlers: vi.fn(() => true),
      },
    };

    await expect((compactSessionWithCachePreservation as any)(session)).rejects.toThrow(
      "This extension ctx is stale after session replacement or reload",
    );
    expect(session.extensionRunner.hasHandlers).not.toHaveBeenCalled();
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("keeps Pi lifecycle events by delegating manual compaction through session.compact", async () => {
    const session = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn(() => true) },
    };

    await expect(compactSessionWithCachePreservation(session, "extra focus")).resolves.toBe("ok");
    expect(session.compact).toHaveBeenCalledWith("extra focus");
  });
});

describe("session snapshot side-task runner", () => {
  function sideTaskSnapshot() {
    return buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      reason: "memory.reflection",
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "stable system",
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    });
  }

  it("appends the suffix after the exact parent prefix and keeps tools", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 10 },
      })),
    }));

    const result = await runSessionSnapshotSideTask({
      snapshot: sideTaskSnapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "medium" },
      suffixMessage: { role: "user", content: [{ type: "text", text: "internal task" }] },
      streamFn,
      options: { reasoning: "medium", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    expect(result.text).toBe("side result");
    expect(result.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      strict: true,
      cacheGroup: "memory.reflection",
    });
    const [, context, options] = streamFn.mock.calls[0] as any;
    expect(context.systemPrompt).toBe("stable system");
    expect(context.tools).toEqual([{ name: "read", description: "Read files", parameters: { type: "object" } }]);
    expect(context.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "text", text: "internal task" }] },
    ]);
    expect(options).toMatchObject({ reasoning: "medium", toolChoice: "none" });
  });

  it("canonicalizes legacy auto in side-task cache params and request options", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
      })),
    }));
    const snap = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      reason: "memory.reflection",
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      systemPrompt: "stable system",
      tools: [],
      messages: [{ role: "user", content: "hello" }],
    });

    await runSessionSnapshotSideTask({
      snapshot: snap,
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "auto", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    const [, , options] = streamFn.mock.calls[0] as any;
    expect(options).toEqual({ reasoning: "medium", toolChoice: "none" });
  });

  it("throws before provider call when strict request contract is broken", async () => {
    const streamFn = vi.fn();
    await expect(runSessionSnapshotSideTask({
      snapshot: sideTaskSnapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "off" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "off", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    })).rejects.toThrow("Session snapshot request is not strict");
    expect(streamFn).not.toHaveBeenCalled();
  });
});
