import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../core/agent.js";

function makeTool(name) {
  return { name };
}

function makeAgent({ experienceEnabled }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-experience-"));
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  const agentDir = path.join(agentsDir, "hana");
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "yuan", "utf-8");
  fs.writeFileSync(path.join(agentDir, "identity.md"), "identity", "utf-8");
  fs.writeFileSync(path.join(agentDir, "ishiki.md"), "ishiki", "utf-8");

  const agent = new Agent({
    id: "hana",
    agentsDir,
    productDir,
    userDir,
  });
  agent._config = {
    locale: "en",
    agent: { name: "Hana", yuan: "hanako" },
    experience: { enabled: experienceEnabled },
  };
  agent.agentName = "Hana";
  agent.userName = "User";
  agent._memoryMasterEnabled = true;
  agent._memorySessionEnabled = true;
  agent._experienceEnabled = experienceEnabled === true;
  agent._memorySearchTool = makeTool("search_memory");
  agent._pinnedMemoryTools = [makeTool("pin_memory"), makeTool("unpin_memory")];
  agent._experienceTools = [makeTool("record_experience"), makeTool("recall_experience")];
  agent._webSearchTool = makeTool("web_search");
  agent._webFetchTool = makeTool("web_fetch");
  agent._todoTool = makeTool("todo_write");
  agent._stageFilesTool = makeTool("stage_files");
  agent._artifactTool = makeTool("create_artifact");
  agent._notifyTool = makeTool("notify");
  agent._stopTaskTool = makeTool("stop_task");
  agent._checkDeferredTool = makeTool("check_pending_tasks");

  return { agent, root };
}

describe("agent experience toggle", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  it("defaults missing experience config to disabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: undefined });
    roots.push(root);

    expect(agent.experienceEnabled).toBe(false);
    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("recall_experience");
  });

  it("excludes experience tools while disabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    // 经验引导已收口进 recall/record 工具的 description，随工具进出。
    // 工具关闭即不进工具集（description 也随之消失），不再单独在 system prompt 注入。
    const toolNames = agent.getToolsSnapshot().map((tool) => tool.name);
    expect(toolNames).not.toContain("record_experience");
    expect(toolNames).not.toContain("recall_experience");
  });

  it("includes experience tools while enabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: true });
    roots.push(root);

    const toolNames = agent.getToolsSnapshot().map((tool) => tool.name);
    expect(toolNames).toContain("record_experience");
    expect(toolNames).toContain("recall_experience");
  });

  it("keeps create_artifact as an explicit legacy compatibility tool only", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("create_artifact");
    expect(agent.getToolsSnapshot({ includeLegacyArtifactTool: true }).map((tool) => tool.name))
      .toContain("create_artifact");
  });

  it("does not expose a top-level wait tool", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("wait");
  });

  it("guides fresh sessions to record session files and deliver them through stage_files", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    const prompt = agent.buildSystemPrompt();
    expect(prompt).toContain("SessionFile means a local file related to the current session");
    expect(prompt).toContain("After write/edit succeeds, the tool layer records the file as session-related automatically");
    expect(prompt).toContain("use stage_files to mark it as delivered");
    expect(prompt).toContain("Do not repeatedly stage the same file once it has already been staged");
    expect(prompt).not.toContain("create_artifact");
  });

  it("lets session creation force the frozen experience tool state", () => {
    const { agent, root } = makeAgent({ experienceEnabled: true });
    roots.push(root);

    const forcedOff = agent.getToolsSnapshot({ forceExperienceEnabled: false }).map((tool) => tool.name);
    expect(forcedOff).not.toContain("record_experience");
    expect(forcedOff).not.toContain("recall_experience");

    const forcedOn = agent.getToolsSnapshot({ forceExperienceEnabled: true }).map((tool) => tool.name);
    expect(forcedOn).toContain("record_experience");
    expect(forcedOn).toContain("recall_experience");
  });
});
