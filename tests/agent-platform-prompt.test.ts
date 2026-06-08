import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../core/agent.ts";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-platform-prompt-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(locale) {
  const root = makeTempDir();
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Yuan prompt", "utf-8");

  const agent = new Agent({ id: "hana", agentsDir, productDir, userDir } as any);
  agent._config = {
    locale,
    agent: { yuan: "hanako" },
    memory: { enabled: false },
    experience: { enabled: false },
  };
  agent.userName = locale.startsWith("zh") ? "用户" : "User";
  agent.agentName = "Hanako";
  return agent;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agent platform prompt identity", () => {
  it("describes the current HanaAgent platform name and the former OpenHanako name in Chinese", () => {
    const prompt = makeAgent("zh-CN").buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("你运行在 HanaAgent 平台上（原名 OpenHanako）");
    expect(prompt).toContain("https://github.com/liliMozi/openhanako");
  });

  it("describes the current HanaAgent platform name and the former OpenHanako name in English", () => {
    const prompt = makeAgent("en").buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("You are running on the HanaAgent platform (formerly OpenHanako)");
    expect(prompt).toContain("https://github.com/liliMozi/openhanako");
  });

  it("formats prompt times with an unambiguous 24-hour clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T07:53:00.000Z"));

    const agent = makeAgent("en");
    agent._cb = { getTimezone: () => "Asia/Shanghai" };

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("Current date and time:");
    expect(prompt).toContain("15:53");
    expect(prompt).toContain("Your day starts at 04:00.");
    expect(prompt).not.toMatch(/\b(?:AM|PM)\b/);
  });
});
