import { describe, expect, it, vi } from "vitest";

import {
  DINGTALK_API_BASE_URL,
  DINGTALK_LEGACY_REST_API_BASE_URL,
  canonicalizeDingTalkBridgeConfig,
  normalizeDingTalkBridgeCredentials,
} from "../lib/bridge/dingtalk-contract.ts";
import {
  DINGTALK_TOKEN_MAX_TTL_SECONDS,
  buildDingTalkAccessTokenRequest,
  parseDingTalkAccessTokenResponse,
  readDingTalkResponse,
  requestDingTalkAccessToken,
} from "../lib/bridge/dingtalk-api.ts";

describe("DingTalk bridge credential contract", () => {
  it("uses canonical non-empty fields before legacy aliases", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-canonical",
      clientId: "client-canonical",
      clientSecret: "secret-canonical",
      robotCode: "robot-canonical",
      apiBaseUrl: "https://gateway.example/v1.0",
      appKey: "client-legacy",
      appSecret: "secret-legacy",
      restBaseUrl: "https://legacy-gateway.example/v1.0",
    })).toMatchObject({
      corpId: "corp-canonical",
      clientId: "client-canonical",
      clientSecret: "secret-canonical",
      robotCode: "robot-canonical",
      apiBaseUrl: "https://gateway.example/v1.0",
    });
  });

  it("reads legacy aliases but canonicalizes persistence fields", () => {
    expect(canonicalizeDingTalkBridgeConfig({
      corpId: "corp-1",
      appKey: "client-legacy",
      appSecret: "secret-legacy",
      robotCode: "robot-1",
      restBaseUrl: DINGTALK_LEGACY_REST_API_BASE_URL,
      enabled: true,
    })).toMatchObject({
      corpId: "corp-1",
      clientId: "client-legacy",
      clientSecret: "secret-legacy",
      robotCode: "robot-1",
      apiBaseUrl: DINGTALK_API_BASE_URL,
      appKey: null,
      appSecret: null,
      restBaseUrl: null,
      enabled: true,
    });
  });

  it("does not resurrect legacy aliases after canonical fields were explicitly cleared", () => {
    expect(canonicalizeDingTalkBridgeConfig({
      corpId: "corp-1",
      clientId: "",
      appKey: "legacy-client",
      clientSecret: "",
      appSecret: "legacy-secret",
      robotCode: "robot-1",
      apiBaseUrl: "",
      restBaseUrl: "https://legacy-gateway.example/v1.0",
    })).toMatchObject({
      clientId: "",
      clientSecret: "",
      apiBaseUrl: DINGTALK_API_BASE_URL,
      appKey: null,
      appSecret: null,
      restBaseUrl: null,
    });
  });

  it("migrates only the exact legacy default host and preserves custom gateways", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      restBaseUrl: `${DINGTALK_LEGACY_REST_API_BASE_URL}/`,
    }).apiBaseUrl).toBe(DINGTALK_API_BASE_URL);

    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      restBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0/",
    }).apiBaseUrl).toBe("https://tenant-gateway.example/dingtalk/v1.0");
  });

  it("preserves an explicit custom Stream registration endpoint", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      streamOpenUrl: "https://stream.example/v1.0/gateway/connections/open#fragment",
    }).streamOpenUrl).toBe("https://stream.example/v1.0/gateway/connections/open");
  });

  it("requires corpId in addition to Stream and robot credentials", () => {
    expect(() => normalizeDingTalkBridgeCredentials({
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    })).toThrow(/corpId/i);
  });

  it("builds the current token request with an encoded corpId", () => {
    const request = buildDingTalkAccessTokenRequest({
      corpId: "corp/a",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      apiBaseUrl: DINGTALK_API_BASE_URL,
    });

    expect(request.url).toBe("https://api.dingtalk.com/v1.0/oauth2/corp%2Fa/token");
    expect(JSON.parse(request.init.body)).toEqual({
      client_id: "client-1",
      client_secret: "secret-1",
      grant_type: "client_credentials",
    });
  });

  it("accepts only the canonical token response fields", () => {
    const credentials = normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    });
    const response = { ok: true, status: 200 };

    expect(parseDingTalkAccessTokenResponse({
      response,
      data: { access_token: "token-1", expires_in: 7200 },
      credentials,
    })).toEqual({
      token: "token-1",
      expiresIn: 7200,
      metadata: { httpStatus: 200 },
    });
    expect(() => parseDingTalkAccessTokenResponse({
      response,
      data: { accessToken: "token-legacy", expireIn: 7200 },
      credentials,
    })).toThrow(/request failed/i);
    expect(() => parseDingTalkAccessTokenResponse({
      response,
      data: { access_token: "token-1" },
      credentials,
    })).toThrow(/request failed/i);
    expect(() => parseDingTalkAccessTokenResponse({
      response,
      data: { access_token: "token-1", expires_in: "7200" },
      credentials,
    })).toThrow(/request failed/i);
    for (const expires_in of [1.5, Number.MAX_SAFE_INTEGER, DINGTALK_TOKEN_MAX_TTL_SECONDS + 1]) {
      expect(() => parseDingTalkAccessTokenResponse({
        response,
        data: { access_token: "token-1", expires_in },
        credentials,
      })).toThrow(/request failed/i);
    }
  });

  it("keeps success metadata on a strict allowlist even when upstream echoes the token", () => {
    const credentials = normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    });
    const result = parseDingTalkAccessTokenResponse({
      response: { ok: true, status: 200 },
      data: {
        access_token: "token-echo",
        expires_in: 7200,
        message: "accepted token-echo",
      },
      credentials,
    });

    expect(result.metadata).toEqual({ httpStatus: 200 });
    expect(JSON.stringify(result.metadata)).not.toContain("token-echo");
  });

  it("reads a token response once and does not retain request secrets or raw data", async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        access_token: "token-1",
        expires_in: 7200,
      })),
      json: vi.fn(),
    };
    const result = await requestDingTalkAccessToken({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    }, async () => response);

    expect(response.text).toHaveBeenCalledOnce();
    expect(response.json).not.toHaveBeenCalled();
    expect(result).toEqual({
      token: "token-1",
      expiresIn: 7200,
      metadata: { httpStatus: 200 },
    });
    expect(JSON.stringify(result)).not.toContain("secret-1");
    expect(JSON.stringify(result)).not.toContain("client_secret");
  });

  it("redacts exact secrets from token transport errors without retaining the cause", async () => {
    const request = requestDingTalkAccessToken({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "short-secret",
      robotCode: "robot-1",
    }, async () => {
      throw new Error("network echoed short-secret");
    });

    await expect(request).rejects.toThrow("network echoed [redacted]");
    try {
      await request;
    } catch (error: any) {
      expect(error).not.toHaveProperty("data");
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("short-secret");
    }
  });

  it("rejects empty and non-JSON token bodies without retaining their raw content", async () => {
    const credentials = {
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    };
    for (const body of ["", "upstream garbage secret-1"]) {
      const request = requestDingTalkAccessToken(credentials, async () => ({
        ok: true,
        status: 200,
        text: async () => body,
      }));
      await expect(request).rejects.toThrow(/request failed/);
      try {
        await request;
      } catch (error: any) {
        expect(error).not.toHaveProperty("data");
        expect(JSON.stringify(error)).not.toContain("secret-1");
        expect(JSON.stringify(error)).not.toContain("upstream garbage");
      }
    }
  });

  it("redacts an access token echoed by a failed token response", async () => {
    const request = requestDingTalkAccessToken({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    }, async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        access_token: "token-must-not-leak",
        expires_in: 7200,
        code: "token-must-not-leak",
        message: "rejected token-must-not-leak",
      }),
    }));

    await expect(request).rejects.toThrow(/rejected \[redacted\].*code=\[redacted\]/);
    try {
      await request;
    } catch (error: any) {
      expect(JSON.stringify(error)).not.toContain("token-must-not-leak");
    }
  });

  it("bounds token response body time and size", async () => {
    await expect(readDingTalkResponse({
      text: () => new Promise<string>(() => {}),
    }, { timeoutMs: 5 })).rejects.toThrow(/timed out/i);

    await expect(readDingTalkResponse({
      text: async () => "123456789",
    }, { maxBytes: 8 })).rejects.toThrow(/exceeded 8 bytes/i);
  });
});
