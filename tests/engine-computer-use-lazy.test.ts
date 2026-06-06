import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";

describe("HanaEngine Computer Use lazy runtime", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function createEngine() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-computer-use-"));
    return new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any);
  }

  it("does not construct the Computer Use runtime during engine construction", () => {
    const engine = createEngine();

    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it("constructs the Computer Use runtime when the global switch is enabled", () => {
    const engine = createEngine();

    const disabled = engine.setComputerUseSettings({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();

    const enabled = engine.setComputerUseSettings({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(engine._computerProviders).toBeTruthy();
    expect(engine._computerHost).toBeTruthy();
  });

  it("disposes the lazy Computer Use runtime during engine shutdown", async () => {
    const engine = createEngine();
    engine.setComputerUseSettings({ enabled: true });
    const dispose = vi.fn(async () => {});
    engine._computerHost = { dispose };

    await engine.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });

  it("stores usage ledger entries under hanakoHome so engine restarts keep them", () => {
    const engine = createEngine();
    engine.usageLedger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      usageContext: {
        source: { subsystem: "session", operation: "reply", surface: "desktop", trigger: "user" },
        attribution: { kind: "session", agentId: "hana", sessionPath: "/sessions/a.jsonl" },
      },
    });

    const restarted = new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any);

    expect(restarted.usageLedger.list({}).entries).toMatchObject([
      {
        attribution: { kind: "session", sessionPath: "/sessions/a.jsonl" },
        usage: { totalTokens: 12 },
      },
    ]);
    expect(fs.existsSync(path.join(tmpDir, "usage-ledger.json"))).toBe(true);
  });
});
