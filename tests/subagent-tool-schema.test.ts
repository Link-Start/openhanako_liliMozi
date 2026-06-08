import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/i18n.ts", () => ({ t: (k: string) => k, getLocale: () => "en" }));

const baseDeps = {
  currentAgentId: "test",
  getParentCwd: () => "/tmp",
  executeIsolated: async () => {},
};

async function loadSubagentToolDef(extraDeps = {}) {
  const mod = await import("../lib/tools/subagent-tool.ts");
  const tool = (mod as any).createSubagentTool({ ...baseDeps, ...extraDeps });
  return tool;
}

describe("subagent tool schema", () => {
  it("does not duplicate generic background task polling rules", async () => {
    const tool = await loadSubagentToolDef();
    expect(tool.description).not.toContain("check_pending_tasks");
    expect(tool.description).not.toContain("Check at most");
    expect(tool.description).not.toContain("<hana-background-result>");
  });

  it("excludes delegation guidance by default (experiment off)", async () => {
    const tool = await loadSubagentToolDef();
    expect(tool.description).not.toContain("direct tool");
    expect(tool.description).not.toContain("protecting the main context window");
    expect(tool.description).toContain("continuable subagent instance");
  });

  it("includes delegation guidance when proactiveDelegation is on", async () => {
    const tool = await loadSubagentToolDef({ proactiveDelegation: true });
    expect(tool.description).toContain("direct tool");
    expect(tool.description).toContain("protecting the main context window");
  });

  it("has correct parameter descriptions", async () => {
    const schema = await loadSubagentToolDef();
    const props = schema.parameters?.properties;
    expect(props?.agent?.description).toMatch(/backticks/);
    expect(props?.agent?.description).toMatch(/persona/);
    expect(props?.agent?.description).toMatch(/model/);
    expect(props?.label?.description).toMatch(/display/i);
    expect(props?.label?.description).toMatch(/threadId|subagent_reply/);
    expect(props?.instance?.description).toMatch(/[Ll]egacy/);
    expect(props?.model?.description).toMatch(/chat model/);
  });
});
