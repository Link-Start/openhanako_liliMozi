import { describe, expect, it } from "vitest";

const localPrincipal = Object.freeze({
  kind: "local_user",
  credentialKind: "loopback_token",
  connectionKind: "local",
  scopes: ["chat", "resources", "tools"],
});

function devicePrincipal(scopes = []) {
  return Object.freeze({
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  });
}

describe("HTTP route security policy", () => {
  it("keeps local owner access unrestricted", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/providers/summary",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/shutdown",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
  });

  it("allows scoped trusted devices to read masked settings without opening local-only admin routes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const principal = devicePrincipal(["chat", "resources.read", "settings.read"]);

    for (const [method, path] of [
      ["GET", "/api/config"],
      ["GET", "/api/providers/summary"],
      ["GET", "/api/preferences/models"],
      ["GET", "/api/bridge/status"],
      ["GET", "/api/agents/hana/config"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: true,
      });
    }

    for (const [method, path] of [
      ["POST", "/api/shutdown"],
      ["GET", "/internal/browser"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: false,
        status: 403,
        error: "local_only_route",
      });
    }
  });

  it("separates remote settings writes, provider management, bridge management, and secret mutation scopes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const settingsWriter = devicePrincipal(["settings.write"]);
    const providerManager = devicePrincipal(["providers.manage"]);
    const bridgeManager = devicePrincipal(["bridge.manage"]);

    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/agents/hana/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/preferences/models", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/preferences/setup-complete", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/test", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/fetch-models", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/providers/deepseek/models/deepseek-chat", principal: providerManager }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/test", principal: bridgeManager }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: settingsWriter }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: providerManager }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
  });

  it("allows scoped device access to chat identity and resources without opening admin APIs", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const principal = devicePrincipal(["chat", "resources.read"]);

    expect(authorizeHttpRoute({ method: "GET", path: "/api/server/identity", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/sessions", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/resources/res_1", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "HEAD", path: "/api/resources/res_1/content", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/resources/res_1/ticket", principal }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/resources/res_1/content", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "insufficient_scope",
      });
  });

  it("treats mobile PWA assets and web-auth login as public bootstrap routes", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.js");

    for (const [method, path] of [
      ["GET", "/mobile/"],
      ["GET", "/mobile/assets/mobile.js"],
      ["GET", "/mobile/manifest.webmanifest"],
      ["GET", "/mobile/sw.js"],
      ["GET", "/mobile/icon.png"],
      ["GET", "/mobile/lib/i18n.js"],
      ["GET", "/mobile/themes/warm-paper.css"],
      ["GET", "/mobile/locales/zh.json"],
      ["POST", "/api/web-auth/login"],
      ["GET", "/api/web-auth/session"],
    ]) {
      expect(classifyHttpRoute({ method, path })).toMatchObject({ kind: "public" });
      expect(authorizeHttpRoute({ method, path, principal: null })).toMatchObject({ allowed: true });
    }
  });

  it("gates mobile workbench routes behind explicit file scopes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const reader = devicePrincipal(["chat", "files.read"]);
    const writer = devicePrincipal(["chat", "files.read", "files.write"]);

    for (const [method, path] of [
      ["GET", "/api/mobile/bootstrap"],
      ["GET", "/api/avatar/agent"],
      ["GET", "/api/agents/hana/avatar"],
      ["GET", "/api/models"],
      ["POST", "/api/models/set"],
      ["POST", "/api/models/switch"],
      ["GET", "/api/session-permission-mode"],
      ["POST", "/api/session-permission-mode"],
      ["POST", "/api/session-thinking-level"],
      ["POST", "/api/confirm/confirm_1"],
      ["GET", "/api/browser/session-states"],
      ["GET", "/api/mobile/workbench/files"],
      ["GET", "/api/mobile/workbench/search"],
      ["GET", "/api/mobile/workbench/content"],
      ["HEAD", "/api/mobile/workbench/content"],
      ["GET", "/api/desk/path"],
      ["GET", "/api/desk/files"],
      ["GET", "/api/desk/search-files"],
      ["GET", "/api/desk/jian"],
      ["GET", "/api/preferences/workspace-ui-state"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: reader }))
        .toMatchObject({ allowed: true });
    }

    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/mobile/workbench/actions",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/mobile/workbench/actions",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/files",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/files",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/jian",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/upload-blob",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/upload-blob",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "PUT",
      path: "/api/preferences/workspace-ui-state",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "PUT",
      path: "/api/preferences/workspace-ui-state",
      principal: writer,
    })).toMatchObject({ allowed: true });
  });

  it("defaults unknown API routes to local-only until they are explicitly classified", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/new-surface",
      principal: devicePrincipal(["chat", "resources.read", "admin"]),
    })).toMatchObject({
      allowed: false,
      status: 403,
      error: "local_only_route",
    });
  });
});
