import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";
import * as provider from "../plugins/jimeng-cli/providers/jimeng-cli.ts";

describe("Jimeng CLI provider contribution", () => {
  it("declares an independent media-only provider", () => {
    const registry = new ProviderRegistry("/tmp/hana-jimeng-provider-test");
    registry.registerProviderContribution({
      ...provider,
      _pluginId: "jimeng-cli",
    });

    const entry = registry.get("jimeng-cli");
    expect(entry).toMatchObject({
      id: "jimeng-cli",
      displayName: "即梦 CLI",
      authType: "none",
      source: { kind: "plugin", pluginId: "jimeng-cli" },
    });
    expect(registry.resolveChatProvider("jimeng-cli")).toMatchObject({
      providerId: "jimeng-cli",
      projection: "none",
    });

    expect(registry.getMediaModels("jimeng-cli", "image_generation")).toEqual([
      expect.objectContaining({
        id: "jimeng-image-5.0",
        displayName: "即梦图片 5.0",
        protocolId: "jimeng-cli-images",
        inputs: ["text", "image"],
        outputs: ["image"],
        modes: expect.arrayContaining([
          expect.objectContaining({
            id: "text2image",
            inputLimits: expect.objectContaining({
              referenceImages: expect.objectContaining({ max: 0 }),
            }),
          }),
          expect.objectContaining({
            id: "image2image",
            inputLimits: expect.objectContaining({
              referenceImages: expect.objectContaining({ min: 1 }),
            }),
          }),
        ]),
      }),
    ]);
    const videoModels = registry.getMediaModels("jimeng-cli", "video_generation");
    expect(videoModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "seedance2.0fast",
        displayName: "Seedance 2.0 Fast",
        protocolId: "jimeng-cli-videos",
        inputs: ["text", "image"],
        outputs: ["video"],
        modes: expect.arrayContaining([
          expect.objectContaining({
            id: "text2video",
            inputLimits: expect.objectContaining({
              referenceImages: expect.objectContaining({ max: 0 }),
            }),
            parameterSchema: expect.objectContaining({
              properties: expect.objectContaining({
                video_resolution: expect.objectContaining({ enum: ["720p"] }),
                duration: expect.objectContaining({ minimum: 4, maximum: 15 }),
              }),
            }),
          }),
          expect.objectContaining({
            id: "image2video",
            inputLimits: expect.objectContaining({
              referenceImages: expect.objectContaining({ min: 1, max: 1 }),
            }),
            parameterSchema: expect.objectContaining({
              properties: expect.objectContaining({
                duration: expect.objectContaining({ minimum: 4, maximum: 15 }),
              }),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        id: "seedance2.0_vip",
        displayName: "Seedance 2.0 VIP",
        modes: expect.arrayContaining([
          expect.objectContaining({
            id: "text2video",
            parameterSchema: expect.objectContaining({
              properties: expect.objectContaining({
                video_resolution: expect.objectContaining({ enum: ["720p", "1080p"] }),
              }),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        id: "3.5pro",
        displayName: "即梦视频 3.5 Pro",
        modes: expect.arrayContaining([
          expect.objectContaining({
            id: "image2video",
            parameterSchema: expect.objectContaining({
              properties: expect.objectContaining({
                duration: expect.objectContaining({ minimum: 4, maximum: 12 }),
              }),
            }),
          }),
        ]),
      }),
    ]));
  });
});
