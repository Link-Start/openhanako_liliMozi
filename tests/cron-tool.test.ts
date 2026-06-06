import { describe, expect, it, vi } from "vitest";
import { createCronTool } from "../lib/tools/cron-tool.ts";

describe("cron tool", () => {
  it("adds studio cron job data with actorAgentId and captured executionContext", async () => {
    const store = {
      addJob: vi.fn((jobData) => ({ ...jobData, id: "studio_job_1", enabled: true })),
      listJobs: vi.fn(() => []),
    };
    const tool = createCronTool(store, {
      autoApprove: true,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/fallback",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: () => "/home/agent-a",
    });

    await tool.execute(
      "call_1",
      {
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "daily report",
        label: "Daily Report",
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/sessions/agent-a.jsonl",
          getCwd: () => "/workspace/current",
        },
      },
    );

    expect(store.addJob).toHaveBeenCalledWith({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "daily report",
      label: "Daily Report",
      model: undefined,
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/current",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
    });
  });
});
