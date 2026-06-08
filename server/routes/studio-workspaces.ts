import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import {
  listStudioMountsForStudio,
  upsertStudioMount,
} from "../../core/studio-mounts.ts";
import { safeJson } from "../hono-helpers.ts";
import { createRequestContext } from "../http/boundary.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";

export function createStudioWorkspacesRoute(engine) {
  const route = new Hono();

  route.get("/studio/workspaces", async (c) => {
    try {
      const auth = authorizeStudioWorkspace(c, engine, "files.read");
      if (auth.response) return auth.response;
      return c.json(await listStudioWorkspaces(engine, auth.requestContext));
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  route.get("/studio/workspaces/:mountId/files", async (c) => {
    try {
      const auth = authorizeStudioWorkspace(c, engine, "files.read");
      if (auth.response) return auth.response;
      const mountId = c.req.param("mountId") || "default";
      return c.json(await fileService(engine, auth.requestContext)
        .listFiles(mountId, c.req.query("subdir") || ""));
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  route.post("/studio/workspaces", async (c) => {
    const auth = authorizeStudioWorkspace(c, engine, "files.write");
    if (auth.response) return auth.response;
    if (!isLocalOwnerPrincipal(auth.requestContext?.authPrincipal)) {
      return c.json({
        error: "local_owner_required",
        capability: "studio.workspace.create_local_path",
      }, 403);
    }

    try {
      const body = await safeJson(c);
      const workspace = await createLocalPathWorkspace(engine, auth.requestContext, body);
      recordSecurityAuditEvent(c, engine, {
        action: "studio_workspace.create_local_path",
        target: {
          kind: "studio",
          studioId: auth.requestContext?.studioId || null,
          mountId: workspace.mountId,
        },
        result: "success",
        decision: auth.decision || null,
      } as any);
      return c.json({
        ok: true,
        workspace,
      });
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  return route;
}

async function listStudioWorkspaces(engine, requestContext) {
  const studioId = requireStudioId(requestContext);
  const workspaces = [];
  const files = fileService(engine, requestContext);
  try {
    workspaces.push(workspaceFromRoot(files.resolveRoot("default"), { isDefault: true }));
  } catch (err) {
    if (!(err instanceof MountAwareFileError && err.code === "no_workspace")) throw err;
  }
  for (const mount of listStudioMountsForStudio(engine.hanakoHome, studioId)) {
    if (mount.status !== "active") continue;
    workspaces.push(workspaceFromMount(mount));
  }
  return {
    studioId,
    workspaces,
  };
}

async function createLocalPathWorkspace(engine, requestContext, body) {
  const studioId = requireStudioId(requestContext);
  const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!rawPath) throw routeError("path must be a non-empty string", "invalid_path", 400);
  if (!path.isAbsolute(rawPath)) throw routeError("path must be absolute on the server", "invalid_path", 400);
  const rootPath = path.resolve(rawPath);
  const stat = await fs.promises.stat(rootPath).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (!stat?.isDirectory()) {
    throw routeError("path must be an existing directory", "invalid_path", 400);
  }

  const mount = upsertStudioMount(engine.hanakoHome, {
    mountId: localFsMountId(studioId, rootPath),
    hostStudioId: studioId,
    sourceKind: "storage",
    provider: "local_fs",
    rootLocator: { path: rootPath },
    label: normalizeWorkspaceLabel(body?.label, rootPath),
    presentation: "folder",
    capabilities: ["list", "read", "write"],
    status: "active",
  });
  return workspaceFromMount(mount);
}

function authorizeStudioWorkspace(c, engine, capability) {
  const requestContext = createRequestContext(c, engine);
  if (requestContext.authPrincipal?.kind === "unknown") return { requestContext, decision: null };
  const decision = requestContext.authorize(capability, {
    kind: "studio",
    studioId: requestContext.studioId,
  });
  if (decision.allowed) return { requestContext, decision };
  recordSecurityAuditEvent(c, engine, {
    action: `studio_workspace.${capability}`,
    target: { kind: "studio", studioId: requestContext.studioId },
    result: "denied",
    decision,
    errorCode: decision.reason,
  } as any);
  return {
    requestContext,
    decision,
    response: c.json({
      error: "insufficient_scope",
      reason: decision.reason,
      capability,
    }, 403),
  };
}

function fileService(engine, requestContext) {
  return new MountAwareFileService({
    hanakoHome: engine.hanakoHome,
    defaultRoot: engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd,
    studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
    createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
      ? (args) => engine.createUserEditCheckpoint(args)
      : null,
  });
}

function workspaceFromRoot(root, { isDefault = false } = {}) {
  return {
    workspaceId: root.workspaceId || root.mountId || root.id,
    mountId: root.mountId || root.id,
    label: root.label,
    sourceKind: root.sourceKind,
    provider: root.provider || null,
    presentation: root.presentation || "folder",
    capabilities: Array.isArray(root.capabilities) ? root.capabilities : [],
    isDefault,
  };
}

function workspaceFromMount(mount) {
  return {
    workspaceId: mount.mountId,
    mountId: mount.mountId,
    label: mount.label,
    sourceKind: mount.sourceKind,
    provider: mount.provider || null,
    presentation: mount.presentation,
    capabilities: Array.isArray(mount.capabilities) ? mount.capabilities : [],
    isDefault: false,
    ...(mount.sourceKind === "studio" ? {
      sourceStudioId: mount.sourceStudioId,
      sourceResourceId: mount.sourceResourceId,
    } : {}),
  };
}

function requireStudioId(requestContext) {
  const studioId = requestContext?.studioId;
  if (typeof studioId !== "string" || !studioId.trim()) {
    throw routeError("studioId required", "studio_required", 400);
  }
  return studioId;
}

function normalizeWorkspaceLabel(label, rootPath) {
  const normalized = typeof label === "string" ? label.trim() : "";
  if (normalized) return normalized;
  return path.basename(rootPath) || "Workspace";
}

function localFsMountId(studioId, rootPath) {
  const digest = crypto.createHash("sha256")
    .update(`${studioId}\0${rootPath}`)
    .digest("hex")
    .slice(0, 16);
  return `local_fs_${digest}`;
}

function routeError(message, code, status) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function workspaceError(c, err) {
  if (err instanceof MountAwareFileError) {
    return c.json({ error: err.code, detail: err.message }, err.status);
  }
  return c.json({ error: err.code || "studio_workspace_failed", detail: err.message }, err.status || 400);
}
