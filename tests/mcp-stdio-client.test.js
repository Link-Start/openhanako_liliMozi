import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  McpStdioClient,
  resolveMcpStdioSpawnSpec,
} from "../plugins/mcp/lib/mcp-stdio-client.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = {
      end: vi.fn(),
      write: vi.fn((line) => {
        const message = JSON.parse(String(line));
        if (message.id == null) return true;
        queueMicrotask(() => {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-11-25", capabilities: {} },
          })}\n`);
        });
        return true;
      }),
    };
    this.kill = vi.fn(() => {
      this.exitCode = 0;
      this.emit("exit", 0);
    });
  }
}

describe("MCP stdio client", () => {
  it("passes connector env and registry settings to spawned stdio servers", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
      env: { API_KEY: "secret" },
      registryUrl: "https://registry.npmmirror.com",
    }, { log: console });

    await client.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "npx",
      ["-y", "mcp-server-example"],
      expect.objectContaining({
        env: expect.objectContaining({
          API_KEY: "secret",
          NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
        }),
        windowsHide: true,
      }),
    );

    await client.stop();
  });

  it("wraps Windows .cmd shims with cmd.exe while preserving registry env", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "pdf",
      command: "npx.cmd",
      args: ["-y", "@sylphx/pdf-reader-mcp"],
      registryUrl: "https://registry.npmmirror.com",
    }, {
      platform: "win32",
      baseEnv: {
        PATH: "C:\\nodejs",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      existsSync: (candidate) => candidate === "C:\\nodejs\\npx.cmd",
    });

    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\nodejs\\npx.cmd -y @sylphx/pdf-reader-mcp",
    ]);
    expect(spec.env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmmirror.com");
  });

  it("wraps bare Windows commands so PATHEXT shims can be resolved by cmd.exe", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "local",
      command: "pdf-reader-mcp",
      args: ["--stdio"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\tools", ComSpec: "cmd.exe" },
      existsSync: () => false,
    });

    expect(spec.command).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/c", "pdf-reader-mcp --stdio"]);
  });

  it("keeps Windows .exe commands on direct spawn", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "node",
      command: "node.exe",
      args: ["server.js"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\nodejs", PATHEXT: ".EXE;.CMD" },
      existsSync: (candidate) => candidate === "C:\\nodejs\\node.exe",
    });

    expect(spec.command).toBe("C:\\nodejs\\node.exe");
    expect(spec.args).toEqual(["server.js"]);
  });

  it("quotes spaced Windows shim paths in the cmd.exe command line", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "spaced",
      command: "C:\\Program Files\\nodejs\\npx.cmd",
      args: ["-y", "package with spaces"],
    }, {
      platform: "win32",
      baseEnv: { ComSpec: "cmd.exe" },
      existsSync: () => true,
    });

    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "\"C:\\Program Files\\nodejs\\npx.cmd\" -y \"package with spaces\"",
    ]);
  });
});
