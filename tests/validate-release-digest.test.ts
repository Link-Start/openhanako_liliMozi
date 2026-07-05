import { describe, expect, it } from "vitest";
import { validateDigestForTag } from "../scripts/validate-release-digest.mjs";

function digest(overrides = {}) {
  return {
    schemaVersion: 1,
    tag: "v0.425.4",
    version: "0.425.4",
    previousTag: "v0.425.3",
    generatedAt: "2026-07-05T00:00:00.000Z",
    noUserFacingChanges: false,
    summary: { zh: "更新说明更清楚。", en: "Update notes are clearer." },
    counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
    source: {
      owner: "liliMozi",
      repo: "openhanako",
      commitRange: "v0.425.3..HEAD",
      releaseUrl: "https://github.com/liliMozi/openhanako/releases/tag/v0.425.4",
      releaseNotes: "",
    },
    items: [
      {
        id: "digest",
        kind: "feature",
        importance: "high",
        title: { zh: "更新摘要", en: "Update digest" },
        summary: { zh: "About 页展示更新内容。", en: "The About page shows update content." },
        details: [],
        sources: [{ type: "commit", ref: "abc123", title: "Add digest" }],
      },
    ],
    ...overrides,
  };
}

describe("validate-release-digest", () => {
  it("accepts a committed digest matching the tag", () => {
    expect(validateDigestForTag(digest(), "v0.425.4").version).toBe("0.425.4");
  });

  it("rejects a digest generated for a different tag", () => {
    expect(() => validateDigestForTag(digest({ tag: "v0.425.3" }), "v0.425.4"))
      .toThrow(/digest\.tag must be v0\.425\.4/);
  });

  it("rejects a digest whose version does not match the tag", () => {
    expect(() => validateDigestForTag(digest({ version: "0.425.3" }), "v0.425.4"))
      .toThrow(/digest\.version must be 0\.425\.4/);
  });
});
