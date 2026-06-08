import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGrantRegistry,
  createGrant,
  findActiveGrantsForPrincipal,
  revokeGrant,
} from "../core/grant-registry.ts";

describe("grant registry", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates an empty registry for old data roots", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-grants-"));
    const registry = ensureGrantRegistry(tmpDir);
    expect(registry).toMatchObject({ schemaVersion: 1, grants: [] });
    expect(fs.existsSync(path.join(tmpDir, "security", "grants.json"))).toBe(true);
  });

  it("creates, finds, and revokes grants", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-grants-"));
    const grant = createGrant(tmpDir, {
      principalId: "principal_device_1",
      subjectKind: "device",
      scope: { studioId: "studio_1" },
      capabilities: ["chat.read", "resources.read"],
      constraints: { transportKinds: ["lan"] },
      now: "2026-05-16T00:00:00.000Z",
    });
    expect(grant.grantId).toMatch(/^grant_/);
    expect(findActiveGrantsForPrincipal(tmpDir, "principal_device_1", {
      now: "2026-05-16T00:00:01.000Z",
    })).toHaveLength(1);
    revokeGrant(tmpDir, grant.grantId, { now: "2026-05-16T00:00:02.000Z" });
    expect(findActiveGrantsForPrincipal(tmpDir, "principal_device_1", {
      now: "2026-05-16T00:00:03.000Z",
    })).toHaveLength(0);
  });

  it("expires grants during active lookup", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-grants-"));
    createGrant(tmpDir, {
      principalId: "principal_device_1",
      subjectKind: "device",
      scope: { studioId: "studio_1" },
      capabilities: ["chat.read"],
      constraints: { expiresAt: "2026-05-16T00:00:02.000Z" },
      now: "2026-05-16T00:00:00.000Z",
    });
    expect(findActiveGrantsForPrincipal(tmpDir, "principal_device_1", {
      now: "2026-05-16T00:00:03.000Z",
    })).toHaveLength(0);
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "security", "grants.json"), "utf-8"));
    expect(raw.grants[0].status).toBe("expired");
  });
});
