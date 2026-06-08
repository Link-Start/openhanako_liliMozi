import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileWeek: vi.fn().mockResolvedValue("compiled"),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { readCacheSnapshotObservation } from "../lib/memory/cache-snapshot-observation.ts";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { role: "user", content: "我想把 rolling summary 接上缓存快照。" },
    },
    {
      type: "message",
      timestamp: "2026-06-03T10:01:00.000Z",
      message: { role: "assistant", content: "我们可以先做 shadow，再切 write。" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, mode, summaryManager, memoryReflectionRunner) {
  const agentDir = path.join(tmpDir, "agents", "hana");
  const sessionDir = path.join(agentDir, "sessions");
  const memoryDir = path.join(agentDir, "memory");
  const requestModel = {
    id: "memory-model",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "http://localhost:1234",
    quirks: ["enable_thinking"],
    reasoning: true,
  };
  const usageLedger = { marker: "usage-ledger" };
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Memory\n\n现有正式记忆。\n", "utf-8");

  const ticker = createMemoryTicker({
    agentId: "hana",
    agentDir,
    summaryManager,
    configPath: path.join(agentDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({
      model: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
      usageLedger,
    }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled: () => true,
    getCacheSnapshotReflectionMode: () => mode,
    memoryReflectionRunner,
    buildSessionCacheSnapshot: vi.fn((sessionPath, { reason, messages }) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      model: {
        id: "memory-model",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "http://localhost:1234",
      },
      requestModel,
      cachePrefixHash: "a".repeat(64),
      parentCachePrefixHash: "",
      cacheKeyParams: { thinkingLevel: "medium" },
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages,
      messageCount: messages.length,
    })),
    getSessionStreamFn: vi.fn(() => vi.fn()),
    sessionDir,
    memoryDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    todayMdPath: path.join(memoryDir, "today.md"),
    weekMdPath: path.join(memoryDir, "week.md"),
    longtermMdPath: path.join(memoryDir, "longterm.md"),
    factsMdPath: path.join(memoryDir, "facts.md"),
  });

  return { ticker, agentDir, requestModel, sessionPath: path.join(sessionDir, "2026-06-03T10-00-00-000Z_cache.jsonl"), usageLedger };
}

describe("cache snapshot reflection runtime", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cache-snapshot-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shadow mode keeps the official rolling summary path and writes only an observation artifact", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "shadow summary",
        changed: true,
        data: { summary: "shadow summary" },
        usage: {
          input: { uncachedTokens: 3 },
          cache: { readTokens: 997, missTokens: 3 },
        },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      agentId: "hana",
      sessionPath,
      mode: "shadow",
      status: "success",
      cacheStrategy: "session_snapshot",
      strict: true,
      summaryPreview: "shadow summary",
    });
    expect(observation.usage.cachedTokens).toBe(997);
    expect(observation.memoryMdPreview).toContain("现有正式记忆");
  });

  it("write mode saves the cache snapshot draft as the official rolling summary", async () => {
    const sessionId = "2026-06-03T10-00-00-000Z_cache";
    const summaryData = {
      session_id: sessionId,
      created_at: "2026-06-03T10:02:00.000Z",
      updated_at: "2026-06-03T10:02:00.000Z",
      summary: "write summary",
      messageCount: 2,
    };
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("legacy summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "write summary",
        changed: true,
        data: summaryData,
        usage: { cache: { readTokens: 1200, missTokens: 4 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    expect(summaryManager.saveSummary).toHaveBeenCalledWith(sessionId, summaryData);

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "success",
      cacheStrategy: "session_snapshot",
      strict: true,
      summaryPreview: "write summary",
    });
  });

  it("write mode refuses non-strict reflection results", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "recovery summary",
        changed: true,
        data: { summary: "recovery summary" },
        usage: { cache: { readTokens: 0, missTokens: 100 } },
        metadata: {
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "session_snapshot_contract_mismatch",
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await expect(ticker.flushSession(sessionPath)).rejects.toThrow("requires a strict session_snapshot");
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "failed",
      cacheStrategy: "cache_recovery",
      strict: false,
      degradeReason: "session_snapshot_contract_mismatch",
    });
  });

  it("passes the runtime session model and usage context to the reflection runner", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "shadow summary",
        changed: true,
        data: { summary: "shadow summary" },
        usage: { cache: { readTokens: 512, missTokens: 8 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, requestModel, sessionPath, usageLedger } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    const args = memoryReflectionRunner.runMemoryReflection.mock.calls[0][0];
    expect(args.model).toBe(requestModel);
    expect(args.snapshot.model).not.toHaveProperty("quirks");
    expect(args.cacheKeyParams).toEqual({ thinkingLevel: "medium" });
    expect(args.usageLedger).toBe(usageLedger);
    expect(args.usageContext).toMatchObject({
      subsystem: "memory",
      operation: "cache_snapshot_reflection",
      trigger: "manual",
    });
  });

  it("writes bounded failure diagnostics for shadow reflection errors", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const error = new TypeError("Cannot read properties of undefined (reading 'includes')");
    error.stack = [
      "TypeError: Cannot read properties of undefined (reading 'includes')",
      "    at providerMatches (core/provider-compat/qwen.js:46:23)",
      "    at runProvider (core/llm-client.js:100:1)",
      "    at extraFrame (core/llm-client.js:101:1)",
      "    at extraFrame2 (core/llm-client.js:102:1)",
      "    at extraFrame3 (core/llm-client.js:103:1)",
    ].join("\n");
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockRejectedValue(error),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "shadow",
      status: "failed",
      reason: "Cannot read properties of undefined (reading 'includes')",
      diagnostics: {
        errorName: "TypeError",
        requestModel: {
          id: "memory-model",
          provider: "deepseek",
          api: "openai-completions",
          hasQuirks: true,
        },
      },
    });
    expect(observation.diagnostics.stack).toHaveLength(4);
    expect(observation.diagnostics.stack[1]).toContain("providerMatches");
  });
});
