import { describe, expect, it, vi } from "vitest";
import {
  executeDirectAutomationAction,
  executePluginAutomationAction,
} from "../lib/desk/automation-executors.js";

describe("automation executors", () => {
  it("delivers notify actions through the notification gateway", async () => {
    const deliverNotification = vi.fn(async () => ({
      ok: true,
      deliveries: [{ channel: "desktop", status: "sent" }],
    }));

    const result = await executeDirectAutomationAction({
      id: "job_notify",
      actorAgentId: "hana",
      executor: {
        kind: "direct_action",
        action: "notify",
        params: {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
      },
    }, { deliverNotification });

    expect(deliverNotification).toHaveBeenCalledWith(
      {
        title: "喝水",
        body: "站起来活动一下",
        channels: ["desktop"],
      },
      { agentId: "hana" },
    );
    expect(result).toMatchObject({
      executorKind: "direct_action",
      action: "notify",
      delivery: {
        ok: true,
        deliveries: [{ channel: "desktop", status: "sent" }],
      },
    });
  });

  it("rejects file.create as an unsupported direct action", async () => {
    await expect(executeDirectAutomationAction({
      id: "job_file",
      executor: {
        kind: "direct_action",
        action: "file.create",
        params: { relativePath: "notes/today.md", content: "# Today\n" },
      },
    }, {})).rejects.toThrow(/unsupported direct automation action: file\.create/);
  });

  it("invokes plugin actions through the plugin action gateway", async () => {
    const invokePluginAction = vi.fn(async () => ({ ok: true, text: "created" }));

    const result = await executePluginAutomationAction({
      id: "job_plugin",
      label: "Create note",
      actorAgentId: "hana",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "hana",
      },
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        params: { title: "Today" },
      },
    }, { invokePluginAction });

    expect(invokePluginAction).toHaveBeenCalledWith(
      { pluginId: "notes", actionId: "create_note", params: { title: "Today" } },
      {
        jobId: "job_plugin",
        label: "Create note",
        actorAgentId: "hana",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace",
          workspaceFolders: ["/workspace/ref"],
          sourceSessionPath: "/sessions/source.jsonl",
          createdByAgentId: "hana",
        },
        cwd: "/workspace",
        workspaceFolders: ["/workspace/ref"],
        sessionPath: "/sessions/source.jsonl",
      },
    );
    expect(result).toEqual({
      executorKind: "plugin_action",
      pluginId: "notes",
      actionId: "create_note",
      result: { ok: true, text: "created" },
    });
  });

  it("requires plugin action identity fields", async () => {
    await expect(executePluginAutomationAction({
      id: "job_plugin",
      executor: {
        kind: "plugin_action",
        pluginId: "",
        actionId: "create_note",
        params: {},
      },
    }, { invokePluginAction: vi.fn() })).rejects.toThrow(/plugin_action\.pluginId is required/);

    await expect(executePluginAutomationAction({
      id: "job_plugin",
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "",
        params: {},
      },
    }, { invokePluginAction: vi.fn() })).rejects.toThrow(/plugin_action\.actionId is required/);
  });
});
