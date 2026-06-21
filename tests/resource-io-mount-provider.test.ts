import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { MountProvider } from "../lib/resource-io/providers/mount-provider.ts";

describe("MountProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function setup() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-mount-"));
    const hanakoHome = path.join(tempRoot, "hana");
    const mountRoot = path.join(tempRoot, "mounted");
    fs.mkdirSync(mountRoot, { recursive: true });
    const studioId = "studio_mount";
    upsertStudioMount(hanakoHome, {
      schemaVersion: 1,
      mountId: "mount_local",
      hostStudioId: studioId,
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted",
      presentation: "folder",
      capabilities: ["list", "read", "write", "watch", "materialize"],
      grantId: null,
    });
    upsertStudioMount(hanakoHome, {
      schemaVersion: 1,
      mountId: "mount_s3",
      hostStudioId: studioId,
      sourceKind: "storage",
      provider: "s3",
      rootLocator: { bucket: "hana" },
      label: "Remote",
      presentation: "folder",
      capabilities: ["list", "read"],
      grantId: null,
    });
    return {
      mountRoot,
      provider: new MountProvider({
        hanakoHome,
        studioId,
        localFsProviderFactory: ({ cwd, guard }) => new LocalFsProvider({ cwd, guard }),
      }),
    };
  }

  it("dispatches local_fs mounts through local path scoping and mount resource keys", async () => {
    const { mountRoot, provider } = setup();
    const result = await provider.write({ kind: "mount", mountId: "mount_local", path: "docs/a.md" }, "hello");

    const target = path.join(mountRoot, "docs", "a.md");
    const realTarget = fs.realpathSync(target);
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(result).toMatchObject({
      changeType: "created",
      resourceKey: "mount:mount_local:docs/a.md",
      resource: {
        kind: "mount",
        mountId: "mount_local",
        path: "docs/a.md",
        provider: "mount",
        filePath: realTarget,
      },
      filePath: realTarget,
    });

    const read = await provider.read({ kind: "mount", mountId: "mount_local", path: "docs/a.md" });
    expect(read.content.toString("utf-8")).toBe("hello");
  });

  it("rejects path escapes and unsupported remote mounts explicitly", async () => {
    const { provider } = setup();

    await expect(provider.read({ kind: "mount", mountId: "mount_local", path: "../secret.md" }))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(provider.read({ kind: "mount", mountId: "mount_s3", path: "a.md" }))
      .rejects.toMatchObject({ code: "provider_not_available" });
  });
});
