import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallSkillTool } from "../lib/tools/install-skill.ts";
import { writeZipFromDirectory } from "../lib/zip-writer.ts";

describe("install_skill global skill-pool installation", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("installs skill_content into the global skill pool and enables the current agent through the callback", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agent");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(agentDir, { recursive: true });
    const sessionPath = "/sessions/install-tool.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_installed_skill",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: label,
      label,
      ext: "md",
      mime: "text/markdown",
      size: 32,
      kind: "markdown",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      skill_name: "demo-skill",
      skill_content: "---\nname: demo-skill\n---\n# Demo\n",
      reason: "test",
    }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    const skillFilePath = path.join(userSkillsDir, "demo-skill", "SKILL.md");
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: skillFilePath,
      label: "SKILL.md",
      origin: "install_skill_output",
      storageKind: "install_output",
    });
    expect(result.details).toMatchObject({
      skillName: "demo-skill",
      skillFilePath,
      installedSkillSource: {
        kind: "skill_source",
        owner: "user",
        skillName: "demo-skill",
        filePath: skillFilePath,
        baseDir: path.dirname(skillFilePath),
        editable: true,
        readonly: false,
      },
      installedFile: {
        id: "sf_installed_skill",
        fileId: "sf_installed_skill",
        sessionPath,
        filePath: skillFilePath,
        origin: "install_skill_output",
        storageKind: "install_output",
      },
    });
    expect(fs.readFileSync(skillFilePath, "utf-8")).toContain("default-enabled: false");
    expect(onInstalled).toHaveBeenCalledWith("demo-skill");
  });

  it("replaces an existing global skill with the same semantics as manual install", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-b");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(path.join(userSkillsDir, "demo-skill"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const existingContent = "---\nname: demo-skill\n---\n# Existing\n";
    fs.writeFileSync(path.join(userSkillsDir, "demo-skill", "SKILL.md"), existingContent, "utf-8");
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      skill_name: "demo-skill",
      skill_content: "---\nname: demo-skill\n---\n# Different\n",
      reason: "test",
    }, null, null, {});

    const originalPath = path.join(userSkillsDir, "demo-skill", "SKILL.md");
    expect(fs.readFileSync(originalPath, "utf-8")).toContain("# Different");
    expect((result as any).details.skillName).toBe("demo-skill");
    expect(onInstalled).toHaveBeenCalledWith("demo-skill");
    expect(fs.existsSync(path.join(userSkillsDir, "demo-skill-agent-b"))).toBe(false);
  });

  it("installs the full GitHub skill package instead of only SKILL.md", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-c");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const repoDir = path.join(tmpDir, "repo", "kami-main");
    fs.mkdirSync(path.join(repoDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "assets", "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "SKILL.md"), "---\nname: kami\n---\n# Kami\n", "utf-8");
    fs.writeFileSync(path.join(repoDir, "references", "design.md"), "# Design\n", "utf-8");
    fs.writeFileSync(path.join(repoDir, "assets", "templates", "page.html"), "<main></main>\n", "utf-8");

    const zipPath = path.join(tmpDir, "kami.zip");
    await writeZipFromDirectory(path.join(tmpDir, "repo"), zipPath);
    const zipBytes = fs.readFileSync(zipPath);
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("api.github.com/repos/tw93/kami")) {
        return new Response(JSON.stringify({ stargazers_count: 5608 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("codeload.github.com/tw93/kami/zip/HEAD")) {
        return new Response(zipBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            allow_github_fetch: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      github_url: "https://github.com/tw93/kami",
      reason: "test",
    }, null, null, {});

    expect((result as any).details.skillName).toBe("kami");
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "references", "design.md"))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "assets", "templates", "page.html"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("raw.githubusercontent.com"), expect.anything());
    expect(onInstalled).toHaveBeenCalledWith("kami");
  });
});
