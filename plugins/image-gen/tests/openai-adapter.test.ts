import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiImageAdapter } from "../adapters/openai.ts";

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-adapter-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCtx(overrides = {}) {
  return {
    dataDir: makeTmpDir(),
    bus: {
      request: vi.fn(async () => ({ apiKey: "test-key", baseUrl: "https://api.openai.test/v1" })),
    },
    config: {
      get: vi.fn(() => null),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("openaiImageAdapter", () => {
  it("logs revised_prompt through object-style ctx.log without blocking image save", async () => {
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          b64_json: Buffer.from("image-bytes").toString("base64"),
          revised_prompt: "a clearer generated prompt",
        }],
      }),
    })));

    const result = await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      model: "gpt-image-1.5",
      filename: "lantern",
    }, ctx);

    expect(ctx.log.info).toHaveBeenCalledWith("[openai-image] revised_prompt: a clearer generated prompt");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated", result.files[0]))).toBe(true);
  });
});
