import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { ResourceService } from "../core/resource-service.ts";
import { ResourceProvider } from "../lib/resource-io/providers/resource-provider.ts";

describe("ResourceProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-provider-"));
    const agentsDir = path.join(tempRoot, "agents");
    const sessionPath = path.join(agentsDir, "hana", "sessions", "a.jsonl");
    const filePath = path.join(tempRoot, "files", "note.txt");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    fs.writeFileSync(filePath, "resource text\n", "utf-8");
    const sessionFiles = new SessionFileRegistry();
    const entry = sessionFiles.registerFile({ sessionPath, filePath, label: "note.txt", origin: "test" });
    const service = new ResourceService({
      agentsDir,
      sessionFiles,
      runtimeContext: { studioId: "studio_resource" },
    });
    return {
      entry,
      provider: new ResourceProvider({ resourceService: service }),
    };
  }

  it("reads, stats, and materializes ResourceService file envelopes", async () => {
    const { entry, provider } = setup();
    const resourceId = `res_${entry.id}`;

    const stat = await provider.stat({ kind: "resource", resourceId });
    expect(stat).toMatchObject({
      exists: true,
      isDirectory: false,
      resourceKey: `resource:${resourceId}`,
      resource: {
        kind: "resource",
        resourceId,
        provider: "resource",
        displayName: "note.txt",
      },
      version: { size: 14 },
    });

    const read = await provider.read({ kind: "resource", resourceId });
    expect(read.content.toString("utf-8")).toBe("resource text\n");

    const materialized = await provider.materialize({ kind: "resource", resourceId });
    expect(materialized.filePath).toBe(read.filePath);

    await expect(provider.write({ kind: "resource", resourceId }, "changed"))
      .rejects.toMatchObject({ code: "capability_denied" });
  });
});
