import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { spawnAndStream } from "../lib/sandbox/exec-helper.ts";

describe("spawnAndStream", () => {
  it("returns when the direct child exits even if a background descendant still holds stdio", async () => {
    const holdInheritedStdioMs = 1800;
    const fixture = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, ${holdInheritedStdioMs})",
      ], {
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      child.unref();
      process.stdout.write("parent-exit\\\\n");
    `;

    const chunks = [];
    const startedAt = performance.now();
    const result = await spawnAndStream(process.execPath, ["-e", fixture], {
      cwd: process.cwd(),
      env: process.env,
      onData: (data: any) => chunks.push(Buffer.from(data).toString("utf8")),
      timeout: 5,
    } as any);
    const elapsedMs = performance.now() - startedAt;

    expect((result as any).exitCode).toBe(0);
    expect(chunks.join("")).toContain("parent-exit");
    expect(elapsedMs).toBeLessThan(900);
  }, 7000);
});
