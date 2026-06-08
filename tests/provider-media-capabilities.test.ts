import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-media-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("ProviderRegistry media capabilities", () => {
  it("exposes built-in official image providers from media capabilities", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("image_generation");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

    expect(byId.get("openai")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-1.5", protocolId: "openai-images" }),
    ]));
    expect(byId.get("openai")?.models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-2" }),
    ]));
    expect(byId.get("dashscope")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wan2.7-image-pro", protocolId: "dashscope-wan-images" }),
      expect.objectContaining({ id: "qwen-image-2.0-pro", protocolId: "dashscope-qwen-multimodal-image" }),
      expect.objectContaining({ id: "qwen-image-plus", protocolId: "dashscope-qwen-text2image" }),
    ]));
    expect(byId.get("minimax")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "image-01", protocolId: "minimax-images" }),
      expect.objectContaining({ id: "image-01-live", protocolId: "minimax-images" }),
    ]));
    expect(byId.get("gemini")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gemini-2.5-flash-image", protocolId: "gemini-generate-content-image" }),
      expect.objectContaining({ id: "gemini-3.1-flash-image-preview", protocolId: "gemini-generate-content-image" }),
    ]));
  });

  it("exposes built-in speech recognition providers without exposing MiniMax Token Plan as STT", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("speech_recognition");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

    expect(byId.get("openai")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-4o-transcribe", protocolId: "openai-audio-transcriptions" }),
      expect.objectContaining({ id: "gpt-4o-mini-transcribe", protocolId: "openai-audio-transcriptions" }),
      expect.objectContaining({ id: "whisper-1", protocolId: "openai-audio-transcriptions" }),
    ]));
    expect(byId.get("mimo")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" }),
    ]));
    expect(registry.get("mimo-token-plan")).toMatchObject({
      id: "mimo-token-plan",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(byId.get("mimo-token-plan")).toMatchObject({
      providerId: "mimo-token-plan",
      displayName: "Xiaomi MiMo Token Plan",
    });
    expect(byId.get("mimo-token-plan")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" }),
    ]));
    expect(byId.get("dashscope")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3-asr-flash", protocolId: "dashscope-qwen-asr-chat" }),
    ]));
    expect(byId.get("volcengine-speech")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bigasr-flash", protocolId: "volcengine-bigasr-transcription" }),
    ]));
    expect(byId.get("system-speech")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "system-speech", protocolId: "system-speech-recognition" }),
    ]));
    expect(byId.has("minimax-token-plan")).toBe(false);
  });

  it("exposes OAuth GPT Image 2 as image_generation without projecting the OAuth alias into chat", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const mediaProviders = registry.getMediaProviders("image_generation");
    const codex = mediaProviders.find((provider) => provider.providerId === "openai-codex-oauth");

    expect(codex).toMatchObject({
      providerId: "openai-codex-oauth",
      displayName: "OpenAI Codex (OAuth)",
    });
    expect(codex.models).toContainEqual(expect.objectContaining({
      id: "gpt-image-2",
      displayName: "GPT Image 2",
      protocolId: "openai-codex-responses-image",
    }));

    expect(registry.resolveChatProvider("openai-codex-oauth")).toMatchObject({
      originalProviderId: "openai-codex-oauth",
      providerId: "openai-codex",
      projection: "sdk-auth-alias",
    });
  });

  it("treats a configured Volcengine Coding Plan credential lane as usable for Volcengine image generation", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "volcengine-coding": {
          api_key: "coding-plan-key",
          base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
          api: "openai-completions",
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const status = registry.getMediaProviderCredentialStatus("volcengine", "image_generation");

    expect(status).toMatchObject({
      hasCredentials: true,
      activeLaneId: "volcengine-coding",
      activeProviderId: "volcengine-coding",
    });
  });

  it("normalizes plugin-contributed CLI media providers into the same registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "jimeng-cli",
      displayName: "即梦 CLI",
      authType: "none",
      _pluginId: "jimeng",
      runtime: {
        kind: "browser-cli",
        protocolId: "browser-cli-media",
        command: {
          executable: "opencli",
          args: [
            { literal: "jimeng" },
            { literal: "generate" },
            { option: "--prompt", from: "prompt" },
            { option: "--model", from: "modelId" },
            { option: "--output", from: "outputDir" },
          ],
          timeoutMs: 120000,
          output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" },
        },
      },
      capabilities: {
        chat: {
          projection: "none",
          runtimeProviderId: "jimeng-cli",
          displayProviderId: "jimeng-cli",
        },
        media: {
          imageGeneration: {
            models: [{
              id: "high_aes_general_v50",
              displayName: "即梦 5.0 Lite",
              protocolId: "browser-cli-media",
              inputs: ["text", "image"],
              outputs: ["image"],
            }],
          },
        },
      },
    });
    registry.reload();

    expect(registry.get("jimeng-cli")).toMatchObject({
      id: "jimeng-cli",
      source: { kind: "plugin", pluginId: "jimeng" },
      runtime: expect.objectContaining({ kind: "browser-cli" }),
    });
    expect(registry.getMediaModels("jimeng-cli", "image_generation")).toEqual([
      expect.objectContaining({
        id: "high_aes_general_v50",
        displayName: "即梦 5.0 Lite",
        protocolId: "browser-cli-media",
      }),
    ]);
    expect(registry.resolveChatProvider("jimeng-cli")).toMatchObject({
      providerId: "jimeng-cli",
      projection: "none",
    });
  });
});
