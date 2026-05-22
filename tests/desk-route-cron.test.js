import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioCronService } from "../core/studio-cron-service.js";

function writeLegacyJobs(root, agentId, jobs) {
  const deskDir = path.join(root, "agents", agentId, "desk");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    path.join(deskDir, "cron-jobs.json"),
    JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
    "utf-8",
  );
}

function createApp(engine) {
  return import("../server/routes/desk.js").then(({ createDeskRoute }) => {
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, { scheduler: { getHeartbeat: vi.fn() } }));
    return app;
  });
}

describe("desk cron route", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists the studio cron store independent of the focused agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      { id: "job_1", type: "cron", schedule: "0 9 * * *", prompt: "a", label: "A", enabled: true, nextRunAt: "2026-05-21T01:00:00.000Z" },
    ]);
    writeLegacyJobs(root, "agent-b", [
      { id: "job_1", type: "cron", schedule: "0 10 * * *", prompt: "b", label: "B", enabled: true, nextRunAt: "2026-05-21T02:00:00.000Z" },
    ]);
    const service = new StudioCronService({ hanakoHome: root, agentsDir, getStudioId: () => "studio-main" });
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => ({ id, agentName: id }),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const first = await app.request("/api/desk/cron");
    engine.currentAgentId = "agent-b";
    const second = await app.request("/api/desk/cron");

    const firstJobs = (await first.json()).jobs;
    const secondJobs = (await second.json()).jobs;
    expect(firstJobs.map((job) => job.actorAgentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(secondJobs.map((job) => job.actorAgentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(secondJobs.map((job) => job.id).sort()).toEqual(firstJobs.map((job) => job.id).sort());
  });

  it("mutates jobs by studio job id without resolving the focused agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const service = new StudioCronService({ hanakoHome: root, agentsDir, getStudioId: () => "studio-main" });
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "studio job",
      label: "Studio Job",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });
    const getAgent = vi.fn((id) => ({ id, agentName: id }));
    const engine = {
      currentAgentId: "agent-b",
      getAgent,
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id: job.id }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).job.enabled).toBe(false);
    expect(service.getJob(job.id).enabled).toBe(false);
    expect(getAgent).not.toHaveBeenCalledWith("agent-b");
  });

  it("adds studio jobs only with explicit actorAgentId and executionContext", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const missing = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", scheduleType: "cron", schedule: "0 9 * * *", prompt: "missing actor" }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "actorAgentId and executionContext required" });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "explicit context",
        label: "Explicit Context",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toEqual(expect.objectContaining({
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    }));
  });

  it("adds direct-action automation jobs through the cron compatibility route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Drink Water",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "direct_action",
          action: "notify",
          params: {
            title: "喝水",
            body: "站起来活动一下",
            channels: ["desktop"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toMatchObject({
      prompt: "",
      label: "Drink Water",
      executor: {
        kind: "direct_action",
        action: "notify",
        params: {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
      },
      createdBy: { kind: "user" },
    });
  });

  it("adds plugin-action automation jobs through the cron compatibility route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        label: "Daily Note",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: { title: "Today" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toMatchObject({
      prompt: "",
      label: "Daily Note",
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        params: { title: "Today" },
      },
      createdBy: { kind: "user" },
    });
  });

  it("rejects removed file.create direct-action jobs through the cron route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "direct_action",
          action: "file.create",
          params: { relativePath: "notes/today.md", content: "# Today\n" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported direct automation action: file.create" });
    expect(service.listJobs()).toEqual([]);
  });
});
