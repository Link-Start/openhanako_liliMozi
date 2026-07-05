import { describe, expect, it, vi } from "vitest";
import { generateDigestWithOpenAI, parseArgs } from "../scripts/generate-release-digest.mjs";

describe("generate-release-digest", () => {
  it("parses local pre-tag defaults without requiring release lookup", () => {
    const args = parseArgs(["--out", "tmp/digest.json"], {
      GITHUB_REF_NAME: "v0.425.4",
      GITHUB_REPOSITORY: "liliMozi/openhanako",
    });
    expect(args).toEqual(expect.objectContaining({
      tag: "v0.425.4",
      previousTag: "auto",
      ref: "HEAD",
      owner: "liliMozi",
      repo: "openhanako",
      out: "tmp/digest.json",
    }));
  });

  it("accepts an explicit git ref and local release notes file", () => {
    const args = parseArgs([
      "--tag", "v0.425.4",
      "--ref", "HEAD",
      "--release-notes-file", "notes.md",
    ], {});

    expect(args).toEqual(expect.objectContaining({
      tag: "v0.425.4",
      ref: "HEAD",
      releaseNotesFile: "notes.md",
    }));
  });

  it("requests strict JSON schema output from OpenAI", async () => {
    const digest = {
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
        commitRange: "v0.425.3..v0.425.4",
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
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ output_text: JSON.stringify(digest) }),
    });

    const result = await generateDigestWithOpenAI(
      { tag: "v0.425.4", version: "0.425.4", commits: [] },
      {
        env: { OPENAI_API_KEY: "test-key" },
        fetchImpl,
        model: "gpt-5.5",
      },
    );

    expect(result.tag).toBe("v0.425.4");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.text.format).toEqual(expect.objectContaining({
      type: "json_schema",
      name: "hana_release_digest",
      strict: true,
    }));
  });
});
