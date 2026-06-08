import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-studio-workspaces-"));
}

async function makeApp(engine: Record<string, any>, principal: Record<string, any> | null = null) {
  const app = new Hono();
  if (principal) {
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze(principal));
      await next();
    });
  }
  const { createStudioWorkspacesRoute } = await import("../server/routes/studio-workspaces.ts");
  app.route("/api", createStudioWorkspacesRoute(engine));
  return app;
}

function localRuntime(studioId = "studio_1") {
  return {
    serverId: "server_1",
    serverNodeId: "node_1",
    userId: "user_1",
    studioId,
    connectionKind: "local",
    credentialKind: "loopback_token",
  };
}

function remotePrincipal(scopes: string[] = ["files.read", "files.write"]) {
  return {
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    trustState: "paired",
    serverNodeId: "node_1",
    userId: "user_1",
    studioId: "studio_1",
    deviceId: "device_1",
    scopes,
  };
}

describe("studio workspaces route", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("lists the default workspace and active Studio mounts without exposing server paths", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "design-assets");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    upsertStudioMount(hanakoHome, {
      mountId: "mount_design",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Design Assets",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      hanakoHome,
      homeCwd: workspace,
      deskCwd: workspace,
      getRuntimeContext: () => localRuntime(),
    });

    const res = await app.request("/api/studio/workspaces");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      studioId: "studio_1",
      workspaces: [
        {
          workspaceId: "default",
          mountId: "default",
          label: "Default",
          sourceKind: "storage",
          provider: "local_fs",
          isDefault: true,
          capabilities: ["list", "read", "write"],
        },
        {
          workspaceId: "mount_design",
          mountId: "mount_design",
          label: "Design Assets",
          sourceKind: "storage",
          provider: "local_fs",
          presentation: "folder",
          isDefault: false,
          capabilities: ["list", "read", "write"],
        },
      ],
    });
    expect(JSON.stringify(data)).not.toContain(workspace);
    expect(JSON.stringify(data)).not.toContain(mountRoot);
  });

  it("lets the local owner add a server-path workspace as a Studio mount", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "client-project");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "brief.md"), "brief", "utf-8");
    const app = await makeApp({
      hanakoHome,
      homeCwd: workspace,
      deskCwd: workspace,
      getRuntimeContext: () => localRuntime(),
    });

    const res = await app.request("/api/studio/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: mountRoot, label: "Client Project" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspace).toMatchObject({
      label: "Client Project",
      sourceKind: "storage",
      provider: "local_fs",
      capabilities: ["list", "read", "write"],
    });
    expect(data.workspace.mountId).toMatch(/^local_fs_/);
    expect(JSON.stringify(data)).not.toContain(mountRoot);

    const files = await app.request(`/api/studio/workspaces/${encodeURIComponent(data.workspace.mountId)}/files`);
    expect(files.status).toBe(200);
    expect(await files.json()).toMatchObject({
      mountId: data.workspace.mountId,
      files: [{ name: "brief.md", isDir: false }],
    });
  });

  it("does not let a remote device register an arbitrary server absolute path as a workspace", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "server-secret");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    const app = await makeApp({
      hanakoHome,
      homeCwd: workspace,
      deskCwd: workspace,
      getRuntimeContext: () => localRuntime(),
    }, remotePrincipal());

    const res = await app.request("/api/studio/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: mountRoot, label: "Server Secret" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "local_owner_required",
      capability: "studio.workspace.create_local_path",
    });
  });
});
