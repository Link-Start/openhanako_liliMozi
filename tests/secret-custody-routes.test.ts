import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

function withPrincipal(app, principal) {
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(principal));
    await next();
  });
}

function remotePrincipal(scopes) {
  return {
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  };
}

describe("secret custody across HTTP routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("masks provider secrets in summary responses", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            headers: { Authorization: "Bearer gateway-secret" },
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers.deepseek.api_key).toBe(MASKED_SECRET);
    expect(body.providers.deepseek.headers.Authorization).toBe(MASKED_SECRET);
    expect(JSON.stringify(body)).not.toContain("sk-provider-secret");
    expect(JSON.stringify(body)).not.toContain("gateway-secret");
  });

  it("reveals a provider api key only through the explicit secret endpoint", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: (name) => name === "deepseek"
        ? { api_key: "sk-provider-secret", base_url: "https://api.deepseek.com", api: "openai-completions" }
        : { api_key: "", base_url: "", api: "" },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const summaryRes = await app.request("/api/providers/summary");
    const summaryBody = await summaryRes.json();
    expect(summaryBody.providers.deepseek.api_key).toBe(MASKED_SECRET);

    const revealRes = await app.request("/api/providers/deepseek/api-key");
    const revealBody = await revealRes.json();
    expect(revealRes.status).toBe(200);
    expect(revealBody).toEqual({ api_key: "sk-provider-secret" });
  });

  it("requires secret scope before a remote provider api key can be revealed", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["providers.manage"]));
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        get: () => null,
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: () => ({ api_key: "sk-provider-secret", base_url: "", api: "" }),
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/deepseek/api-key");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "secret_read_scope_required",
      scope: "secrets.write",
    });
  });

  it("preserves saved provider secrets when a masked config patch is submitted", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://old.example/v1",
            api_key: "sk-saved-provider",
            headers: { Authorization: "Bearer saved-gateway" },
          },
        }),
        saveProvider,
      },
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: {
            base_url: "https://new.example/v1",
            api_key: MASKED_SECRET,
            headers: { Authorization: MASKED_SECRET, "X-Corp-Auth": "new-token" },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      base_url: "https://new.example/v1",
      api_key: "sk-saved-provider",
      headers: {
        Authorization: "Bearer saved-gateway",
        "X-Corp-Auth": "new-token",
      },
    });
  });

  it("masks global preference secrets and resolves masked updates back to saved values", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const setSearchConfig = vi.fn();
    const setUtilityApi = vi.fn();
    const engine = {
      getSharedModels: () => ({}),
      getSearchConfig: () => ({ provider: "tavily", api_key: "tvly-secret" }),
      getUtilityApi: () => ({ provider: "openai", base_url: "https://api.example/v1", api_key: "sk-utility" }),
      setSearchConfig,
      setUtilityApi,
      emitEvent: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const readRes = await app.request("/api/preferences/models");
    const readBody = await readRes.json();
    expect(readBody.search.api_key).toBe(MASKED_SECRET);
    expect(readBody.utility_api.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(readBody)).not.toContain("tvly-secret");
    expect(JSON.stringify(readBody)).not.toContain("sk-utility");

    const writeRes = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: { provider: "tavily", api_key: MASKED_SECRET },
        utility_api: { provider: "openai", base_url: "https://new.example/v1", api_key: MASKED_SECRET },
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(setSearchConfig).toHaveBeenCalledWith({ provider: "tavily", api_key: "tvly-secret" });
    expect(setUtilityApi).toHaveBeenCalledWith({
      provider: "openai",
      base_url: "https://new.example/v1",
      api_key: "sk-utility",
    });
  });

  it("masks bridge secrets in status and preserves masked config updates", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          telegram: { token: "tg-secret", enabled: true },
          feishu: { appId: "cli-id", appSecret: "fs-secret" },
          dingtalk: {
            corpId: "corp-1",
            clientId: "dt-client",
            clientSecret: "dt-secret",
            robotCode: "ding-robot",
            restBaseUrl: "https://api.dingtalk.io/v1.0",
          },
          qq: { appID: "qq-id", appSecret: "qq-secret" },
          wechat: { botToken: "wx-secret" },
        },
      },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const bridgeManager = {
      getStatus: () => ({}),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));

    const readRes = await app.request("/api/bridge/status");
    const readBody = await readRes.json();

    expect(readBody.telegram.token).toBe(MASKED_SECRET);
    expect(readBody.telegram.hasToken).toBe(true);
    expect(readBody.feishu.appSecret).toBe(MASKED_SECRET);
    expect(readBody.feishu.hasAppSecret).toBe(true);
    expect(readBody.feishu.region).toBe("feishu_cn");
    expect(readBody.feishu.domain).toBe("https://open.feishu.cn");
    expect(readBody.dingtalk.clientSecret).toBe(MASKED_SECRET);
    expect(readBody.dingtalk.hasClientSecret).toBe(true);
    expect(readBody.dingtalk.corpId).toBe("corp-1");
    expect(readBody.dingtalk.clientId).toBe("dt-client");
    expect(readBody.dingtalk.robotCode).toBe("ding-robot");
    expect(readBody.dingtalk.apiBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.dingtalk.restBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.qq.appSecret).toBe(MASKED_SECRET);
    expect(readBody.qq.hasAppSecret).toBe(true);
    expect(readBody.wechat.token).toBe(MASKED_SECRET);
    expect(readBody.wechat.hasBotToken).toBe(true);
    expect(JSON.stringify(readBody)).not.toContain("tg-secret");
    expect(JSON.stringify(readBody)).not.toContain("fs-secret");
    expect(JSON.stringify(readBody)).not.toContain("dt-secret");
    expect(JSON.stringify(readBody)).not.toContain("qq-secret");
    expect(JSON.stringify(readBody)).not.toContain("wx-secret");

    const writeRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "telegram",
        credentials: { token: MASKED_SECRET },
        enabled: false,
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        telegram: { token: "tg-secret", enabled: false },
      },
    });

    agent.updateConfig.mockClear();
    const feishuWriteRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: MASKED_SECRET, region: "lark_global" },
        enabled: true,
      }),
    });

    expect(feishuWriteRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        feishu: { appId: "cli-id", appSecret: "fs-secret", region: "lark_global", enabled: true },
      },
    });

    agent.updateConfig.mockClear();
    const dingtalkWriteRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: MASKED_SECRET,
          robotCode: "ding-robot",
        },
        enabled: false,
      }),
    });

    expect(dingtalkWriteRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        dingtalk: expect.objectContaining({
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: "dt-secret",
          robotCode: "ding-robot",
          apiBaseUrl: "https://api.dingtalk.com/v1.0",
          appKey: null,
          appSecret: null,
          restBaseUrl: null,
          enabled: false,
        }),
      },
    });
  });

  it("tests DingTalk bridge plaintext credentials without requiring saved config", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: "dt-plaintext",
          robotCode: "ding-robot",
        },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      info: {
        msg: expect.any(String),
        credentialOk: true,
        eventDelivery: "stream",
        callbackUrlRequired: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/oauth2/corp-1/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "dt-client",
          client_secret: "dt-plaintext",
          grant_type: "client_credentials",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fingerprints the reloaded persisted DingTalk secret after config save", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const { initDebugLog } = await import("../lib/debug-log.ts");
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dingtalk-log-"));
    const debug = initDebugLog(logDir);
    const logSpy = vi.spyOn(debug, "log");
    const incomingSecret = "incoming-secret-value";
    const persistedSecret = "persisted-different-value";
    const agent: any = {
      id: "hana",
      config: { bridge: { dingtalk: {} } },
      updateConfig: vi.fn(() => {
        agent.config.bridge.dingtalk = {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: persistedSecret,
          robotCode: "robot-1",
          apiBaseUrl: "https://api.dingtalk.com/v1.0",
          enabled: false,
        };
      }),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    };
    const stopPlatform = vi.fn();
    const startPlatformFromConfig = vi.fn();
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, {
      getStatus: () => ({}),
      stopPlatform,
      startPlatformFromConfig,
    }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: incomingSecret,
          robotCode: "robot-1",
        },
        enabled: false,
      }),
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/not persisted intact/i);
    const diagnostic = logSpy.mock.calls
      .map((call) => String(call[1] || ""))
      .find((line) => line.includes("stage=config_save"));
    expect(diagnostic).toContain(`incoming.length=${incomingSecret.length}`);
    expect(diagnostic).toContain(`persisted.length=${persistedSecret.length}`);
    expect(diagnostic).toContain("match=false");
    expect(diagnostic).not.toContain(incomingSecret);
    expect(diagnostic).not.toContain(persistedSecret);
    expect(stopPlatform).toHaveBeenCalledWith("dingtalk", "hana");
    expect(startPlatformFromConfig).not.toHaveBeenCalled();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("starts DingTalk from the reloaded persisted configuration", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: { bridge: { dingtalk: {} } },
      updateConfig: vi.fn((partial) => {
        agent.config.bridge.dingtalk = {
          ...partial.bridge.dingtalk,
          robotCode: "persisted-robot-code",
        };
        for (const [key, value] of Object.entries(agent.config.bridge.dingtalk)) {
          if (value === null) delete agent.config.bridge.dingtalk[key];
        }
      }),
    };
    const startPlatformFromConfig = vi.fn();
    const app = new Hono();
    app.route("/api", createBridgeRoute({
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    }, {
      getStatus: () => ({}),
      startPlatformFromConfig,
      stopPlatform: vi.fn(),
    }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: "secret-1",
          robotCode: "submitted-robot-code",
          apiBaseUrl: "https://api.dingtalk.com/v1.0",
        },
        enabled: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(startPlatformFromConfig).toHaveBeenCalledWith(
      "dingtalk",
      expect.objectContaining({
        clientSecret: "secret-1",
        robotCode: "persisted-robot-code",
        enabled: true,
      }),
      "hana",
    );
  });

  it("projects enabled DingTalk without corpId as an explicit config error", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            enabled: true,
            clientId: "dt-client",
            clientSecret: "dt-secret",
            robotCode: "ding-robot",
          },
        },
      },
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, {
      getStatus: () => ({ dingtalk: { status: "connected", error: null } }),
    }));

    const res = await app.request("/api/bridge/status?agentId=hana");
    const body = await res.json();

    expect(body.dingtalk).toMatchObject({
      enabled: true,
      configured: false,
      status: "error",
      configError: expect.stringMatching(/corpId/i),
      error: expect.stringMatching(/corpId/i),
      hasClientSecret: true,
    });
  });

  it("tests DingTalk credentials against the configured API base URL", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp/custom",
          clientId: "dt-client",
          clientSecret: "dt-plaintext",
          robotCode: "ding-robot",
          apiBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0/",
        },
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tenant-gateway.example/dingtalk/v1.0/oauth2/corp%2Fcustom/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "dt-client",
          client_secret: "dt-plaintext",
          grant_type: "client_credentials",
        }),
      }),
    );
  });

  it("tests saved DingTalk credentials with omitted secret and legacy aliases", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-legacy",
            appKey: "legacy-client",
            appSecret: "legacy-secret",
            robotCode: "legacy-robot",
            restBaseUrl: "https://api.dingtalk.io/v1.0",
          },
        },
      },
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        useSavedCredentials: true,
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/oauth2/corp-legacy/token",
      expect.objectContaining({
        body: JSON.stringify({
          client_id: "legacy-client",
          client_secret: "legacy-secret",
          grant_type: "client_credentials",
        }),
      }),
    );
  });

  it("does not revive a legacy DingTalk secret when an existing canonical field is empty", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const agent = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-1",
            clientId: "client-1",
            clientSecret: "",
            appSecret: "legacy-must-stay-cleared",
            robotCode: "robot-1",
          },
        },
      },
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute({
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "dingtalk", useSavedCredentials: true }),
    });
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/clientSecret/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a legacy DingTalk patch replace canonical saved fields", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-1",
            clientId: "canonical-old-client",
            clientSecret: "canonical-old-secret",
            robotCode: "robot-1",
            apiBaseUrl: "https://api.dingtalk.com/v1.0",
            enabled: false,
          },
        },
      },
      updateConfig: vi.fn((partial) => {
        const next = { ...agent.config.bridge.dingtalk, ...partial.bridge.dingtalk };
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete next[key];
        }
        agent.config.bridge.dingtalk = next;
      }),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute({
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    }, { getStatus: () => ({}), stopPlatform: vi.fn() }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          appKey: "legacy-new-client",
          appSecret: "legacy-new-secret",
          restBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0",
        },
        enabled: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(agent.config.bridge.dingtalk).toMatchObject({
      clientId: "legacy-new-client",
      clientSecret: "legacy-new-secret",
      apiBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0",
    });
    expect(agent.config.bridge.dingtalk).not.toHaveProperty("appKey");
    expect(agent.config.bridge.dingtalk).not.toHaveProperty("appSecret");
    expect(agent.config.bridge.dingtalk).not.toHaveProperty("restBaseUrl");
  });

  it("lets an explicit DingTalk secret override the selected saved config", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = {
      id: "agent-b",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-b",
            clientId: "client-b",
            clientSecret: "saved-secret-b",
            robotCode: "robot-b",
          },
        },
      },
    };
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => id === "agent-b" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=agent-b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        useSavedCredentials: true,
        credentials: { clientSecret: "fresh-secret-b" },
      }),
    });

    expect((await res.json()).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      client_id: "client-b",
      client_secret: "fresh-secret-b",
    });
  });

  it("does not read the current agent when testing explicit DingTalk plaintext", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAgent = vi.fn(() => {
      throw new Error("saved config must not be read");
    });
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: "agent-a", getAgent }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        useSavedCredentials: false,
        credentials: {
          corpId: "corp-explicit",
          clientId: "client-explicit",
          clientSecret: "secret-explicit",
          robotCode: "robot-explicit",
        },
      }),
    });

    expect((await res.json()).ok).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).client_secret).toBe("secret-explicit");
  });

  it("clears a legacy appSecret when canonical clientSecret is explicitly empty", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-1",
            appKey: "legacy-client",
            appSecret: "legacy-secret",
            robotCode: "robot-1",
          },
        },
      },
      updateConfig: vi.fn((partial) => {
        const next = {
          ...agent.config.bridge.dingtalk,
          ...partial.bridge.dingtalk,
        };
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete next[key];
        }
        agent.config.bridge.dingtalk = next;
      }),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, {
      getStatus: () => ({}),
      stopPlatform: vi.fn(),
    }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: { clientSecret: "" },
        enabled: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        dingtalk: expect.objectContaining({
          clientId: "legacy-client",
          clientSecret: "",
          appKey: null,
          appSecret: null,
          restBaseUrl: null,
        }),
      },
    });
  });

  it("restores a masked DingTalk alias only in explicit saved-credential mode", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "dt-access-token", expires_in: 7200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = {
      id: "hana",
      config: {
        bridge: {
          dingtalk: {
            corpId: "corp-legacy",
            appKey: "legacy-client",
            appSecret: "legacy-secret",
            robotCode: "legacy-robot",
          },
        },
      },
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        useSavedCredentials: true,
        credentials: {
          corpId: "corp-legacy",
          clientId: "legacy-client",
          clientSecret: MASKED_SECRET,
          robotCode: "legacy-robot",
        },
      }),
    });

    expect((await res.json()).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).client_secret).toBe("legacy-secret");
  });

  it("requires an explicit agent for useSavedCredentials", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: "hana" }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "dingtalk", useSavedCredentials: true }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agentId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let the explicit plaintext test mode recover a displayed mask", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: null }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        useSavedCredentials: false,
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: MASKED_SECRET,
          robotCode: "robot-1",
        },
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/useSavedCredentials=true/);
    expect(fetchMock).not.toHaveBeenCalled();

    const omittedModeRes = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: MASKED_SECRET,
          robotCode: "robot-1",
        },
      }),
    });
    expect(omittedModeRes.status).toBe(400);
    expect((await omittedModeRes.json()).error).toMatch(/useSavedCredentials=true/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts a DingTalk secret echoed by an upstream token error", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: "invalid_secret", message: "rejected short-secret" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: null, getAgent: () => null }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          clientSecret: "short-secret",
          robotCode: "robot-1",
        },
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("short-secret");
    expect(body.error).toContain("[redacted]");
  });

  it("rejects DingTalk custom webhook credentials instead of mixing chains", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent = {
      id: "hana",
      config: { bridge: { dingtalk: {} } },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=custom",
          webhookSecret: "custom-secret",
        },
        enabled: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/custom robot webhook fields/i);
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  it("reports missing DingTalk Enterprise Stream fields explicitly", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: "dt-plaintext",
        },
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/enterprise robotCode/i);
  });

  it("tests a saved legacy QQ token through the canonical appSecret request field", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ access_token: "qq-access-token" }) })
      .mockResolvedValueOnce({ json: async () => ({ id: "bot-1", username: "hana-bot" }) });
    vi.stubGlobal("fetch", fetchMock);
    const agent = {
      id: "hana",
      config: {
        bridge: {
          qq: { appID: "legacy-qq-app", token: "legacy-qq-secret" },
        },
      },
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute({
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "qq",
        credentials: { appID: "legacy-qq-app" },
        useSavedCredentials: true,
      }),
    });

    expect((await res.json()).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: "legacy-qq-app",
      clientSecret: "legacy-qq-secret",
    });
  });

  it("clears a legacy QQ token when canonical appSecret is explicitly empty", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          qq: { appID: "legacy-qq-app", token: "legacy-qq-secret", enabled: false },
        },
      },
      updateConfig: vi.fn((partial) => {
        const next = { ...agent.config.bridge.qq, ...partial.bridge.qq };
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete next[key];
        }
        agent.config.bridge.qq = next;
      }),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute({
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
    }, { getStatus: () => ({}), stopPlatform: vi.fn() }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "qq",
        credentials: { appSecret: "" },
        enabled: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(agent.config.bridge.qq.appSecret).toBe("");
    expect(agent.config.bridge.qq).not.toHaveProperty("token");
  });

  it("tests bridge plaintext credentials without requiring an existing saved agent config", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "fs-plaintext", region: "lark_global" },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      info: {
        msg: expect.any(String),
        credentialOk: true,
        region: "lark_global",
        domain: "https://open.larksuite.com",
        eventDelivery: "long_connection",
        callbackUrlRequired: false,
        credentialVerification: {
          status: "tested",
          method: "tenant_access_token",
          endpoint: "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        },
        longConnection: {
          status: "not_tested",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        body: JSON.stringify({ app_id: "cli-id", app_secret: "fs-plaintext" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns structured Feishu credential diagnostics without implying webhook setup", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        code: 99991663,
        msg: "app not found",
        error: { log_id: "202605300001" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "bad-secret" },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({
      ok: false,
      error: "app not found",
      info: {
        credentialOk: false,
        region: "feishu_cn",
        domain: "https://open.feishu.cn",
        eventDelivery: "long_connection",
        callbackUrlRequired: false,
        httpStatus: 400,
        feishuCode: 99991663,
        feishuMessage: "app not found",
        logId: "202605300001",
      },
    });
  });

  it("rejects unsupported Feishu regions on config save", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent = {
      id: "hana",
      config: { bridge: { feishu: { appId: "cli-id", appSecret: "fs-secret" } } },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "fs-secret", region: "unknown-region" },
        enabled: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported Feishu region/) });
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  it("resolves masked bridge test credentials from the explicit agent only", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "qq-token" }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ id: "bot-1", username: "Agent B Bot" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const agentA = {
      id: "agent-a",
      config: {
        bridge: {
          qq: { appID: "app-a", appSecret: "secret-a" },
        },
      },
    };
    const agentB = {
      id: "agent-b",
      config: {
        bridge: {
          qq: { appID: "app-b", appSecret: "secret-b" },
        },
      },
    };
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => ({ "agent-a": agentA, "agent-b": agentB }[id] || null),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=agent-b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "qq",
        useSavedCredentials: true,
        credentials: { appID: "app-b", appSecret: MASKED_SECRET },
      }),
    });
    const body = await res.json();

    expect(body).toEqual({ ok: true, info: { username: "Agent B Bot", name: "Agent B Bot" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      expect.objectContaining({
        body: JSON.stringify({ appId: "app-b", clientSecret: "secret-b" }),
      }),
    );
  });

  it("rejects masked bridge test credentials without an explicit agent id", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const agent = {
      id: "agent-a",
      config: {
        bridge: {
          qq: { appID: "app-a", appSecret: "secret-a" },
        },
      },
    };
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => id === "agent-a" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "qq",
        useSavedCredentials: true,
        credentials: { appID: "app-a", appSecret: MASKED_SECRET },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("agentId is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
