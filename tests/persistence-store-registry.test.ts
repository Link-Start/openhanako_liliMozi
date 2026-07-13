import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverSites,
  pathPatternsOverlap,
  scanPersistentStores,
  validateRegistry,
} from "../scripts/scan-persistent-stores.mjs";
import {
  PERSISTENCE_EXEMPTIONS,
  PERSISTENT_STORES,
} from "../shared/persistence/store-registry.ts";
import { PRODUCTION_ROOTS, SOURCE_EXCLUSIONS } from "../scripts/scan-persistent-stores.mjs";
import type { PersistenceExemption, StoreDescriptor } from "../shared/persistence/store-registry-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = path.join(ROOT, "build", "persistence-store-inventory.json");
const TODAY = "2026-07-13";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-persistence-scan-"));
  tempDirs.push(root);
  for (const productionRoot of PRODUCTION_ROOTS) {
    fs.mkdirSync(path.join(root, productionRoot), { recursive: true });
  }
  return root;
}

function dummyStore(id: string, pathPattern: string, pathKind: "file" | "tree" = "file"): StoreDescriptor {
  return {
    ...PERSISTENT_STORES[0],
    id,
    pathPattern,
    pathPatterns: [pathPattern],
    pathKind,
    siteRules: [],
  };
}

describe("persistent store registry", () => {
  it("owns every production persistence site exactly once", () => {
    const { inventory } = scanPersistentStores({ rootDir: ROOT, today: TODAY });

    expect(inventory.stores).toHaveLength(PERSISTENT_STORES.length);
    expect(inventory.discoveredSites.length).toBeGreaterThan(500);
    for (const site of inventory.discoveredSites) {
      expect(Number(Boolean(site.storeId)) + Number(Boolean(site.exemptionId))).toBe(1);
      expect(site.reason).toBeTruthy();
    }
  });

  it("keeps required store contracts explicit and session identity path-independent", () => {
    const ids = new Set(PERSISTENT_STORES.map((store) => store.id));
    expect([...ids]).toEqual(expect.arrayContaining([
      "data-epoch-stamp",
      "server-node-identity",
      "user-studio-registries",
      "local-user-auth",
      "device-access-registries",
      "server-network-config",
      "studio-mount-registry",
      "web-session-registry",
      "security-grants",
      "execution-leases",
      "security-key-material",
      "security-audit-log",
      "user-preferences",
      "agent-facts-sqlite",
      "session-manifest-sqlite",
      "session-jsonl",
      "session-files",
      "cron-automation",
      "subagent-state",
      "plugin-task-registry",
      "deferred-result-state",
      "terminal-session-state",
      "skill-translation-cache",
      "plugin-runtime-data",
      "legacy-upload-cache",
      "character-card-staging",
      "desk-cover-upload-staging",
      "office-render-jobs",
      "plugin-download-cache",
      "skill-state",
      "usage-ledger",
      "operational-checkpoints",
      "desktop-diagnostics",
      "desktop-gpu-startup-state",
      "desktop-window-version-state",
      "managed-runtime-caches",
      "legacy-pi-search-cache",
    ]));

    for (const store of PERSISTENT_STORES) {
      expect(store.id).toBeTruthy();
      expect(store.ownerModule).toMatch(/\//);
      expect(store.pathPattern).toBe(store.pathPatterns[0]);
      expect(store.pathPatterns.length).toBeGreaterThan(0);
      expect(Array.isArray(store.pathExclusions)).toBe(true);
      expect(store.schemaSource.kind).toMatch(/^(sqlite-runtime|runtime-contract|external-versioned|directory-contract|narrow-exemption)$/);
      expect(store.openEntry.length).toBeGreaterThan(0);
      expect(store.checkpointPolicy).toBeTruthy();
      expect(store.restorePolicy).toBeTruthy();
      expect(store.identityContract).toBeTruthy();
      if (store.firstPossibleWritePhase === "desktop_bootstrap" || store.firstPossibleWritePhase === "home_guard") {
        expect(store.affectedByEpochMigration).toBe(false);
        expect(store.bootstrapSafety).not.toBeNull();
      }
    }

    const facts = PERSISTENT_STORES.find((store) => store.id === "agent-facts-sqlite")!;
    expect(facts.schemaSource).toMatchObject({ kind: "sqlite-runtime", module: "lib/memory/fact-store.ts" });

    const sessions = PERSISTENT_STORES.find((store) => store.id === "session-jsonl")!;
    expect(sessions.schemaSource).toMatchObject({
      kind: "external-versioned",
      lockfile: "package-lock.json integrity",
      versionSource: "Pi CURRENT_SESSION_VERSION",
    });
    expect(sessions.identityContract).toContain("sessionId is identity");
    expect(sessions.identityContract).toContain("sessionPath is a mutable locator");

    const cache = PERSISTENT_STORES.find((store) => store.id === "managed-runtime-caches")!;
    expect(cache.pathPatterns).toContain("runtime/pi-sdk/bin/{toolName}");
    expect(cache.epochPolicy).toBe("regenerable");
    const legacy = PERSISTENT_STORES.find((store) => store.id === "legacy-pi-search-cache")!;
    expect(legacy.pathPattern).toBe(".pi/agent/bin/{toolName}");
    expect(legacy.epochPolicy).toBe("migration-source");

    const pluginData = PERSISTENT_STORES.find((store) => store.id === "plugin-runtime-data")!;
    expect(pluginData.pathExclusions).toEqual([
      "plugin-data/office/jobs",
      "plugin-data/office/generated",
    ]);
    const office = PERSISTENT_STORES.find((store) => store.id === "office-render-jobs")!;
    expect(office.ownerModule).toBe("plugins/office/lib/html-to-pdf.ts");
    expect(office.pathPatterns).toEqual([
      "plugin-data/office/jobs",
      "plugin-data/office/generated",
    ]);
  });

  it("rejects duplicate IDs, overlapping paths, and Windows-only case collisions", () => {
    const duplicate = dummyStore("duplicate", "one.json");
    expect(() => validateRegistry({ stores: [duplicate, { ...duplicate }], exemptions: [], today: TODAY }))
      .toThrow(/duplicate store id/);

    const tree = dummyStore("tree", "agents/{agentId}", "tree");
    const child = dummyStore("child", "agents/a/config.json");
    expect(pathPatternsOverlap(tree, child, "posix")).toBe(true);
    expect(() => validateRegistry({ stores: [tree, child], exemptions: [], today: TODAY }))
      .toThrow(/overlaps on posix/);

    const upper = dummyStore("upper", "State/Registry.json");
    const lower = dummyStore("lower", "state/registry.json");
    expect(pathPatternsOverlap(upper, lower, "posix")).toBe(false);
    expect(pathPatternsOverlap(upper, lower, "win32")).toBe(true);
    expect(() => validateRegistry({ stores: [upper, lower], exemptions: [], today: TODAY }))
      .toThrow(/overlaps on win32/);
  });

  it("allows only strict child carve-outs fully taken over by one tree descriptor", () => {
    const parent = {
      ...dummyStore("parent", "plugin-data/{pluginId}", "tree"),
      pathExclusions: ["plugin-data/office/jobs"],
    };
    const child = dummyStore("child", "plugin-data/office/jobs", "tree");
    expect(pathPatternsOverlap(parent, child, "posix")).toBe(false);
    expect(() => validateRegistry({ stores: [parent, child], exemptions: [], today: TODAY })).not.toThrow();

    expect(() => validateRegistry({ stores: [parent], exemptions: [], today: TODAY }))
      .toThrow(/must be fully owned by exactly one tree descriptor/);

    const outside = { ...parent, pathExclusions: ["artifacts/staging"] };
    expect(() => validateRegistry({ stores: [outside, child], exemptions: [], today: TODAY }))
      .toThrow(/pathExclusion is outside its ownership/);

    const withoutOfficeCarveOut = PERSISTENT_STORES.map((store) => (
      store.id === "plugin-runtime-data" ? { ...store, pathExclusions: [] } : store
    ));
    expect(() => validateRegistry({ stores: withoutOfficeCarveOut, exemptions: PERSISTENCE_EXEMPTIONS, today: TODAY }))
      .toThrow(/store path ownership overlaps/);
  });

  it("rejects expired and dangling exemptions", () => {
    const expired: PersistenceExemption = {
      id: "expired",
      ownerModule: "core/example.ts",
      sourceFile: "core/example.ts",
      reason: "test",
      expiresOn: "2026-07-12",
    };
    expect(() => validateRegistry({ stores: [], exemptions: [expired], today: TODAY })).toThrow(/expired/);

    const dangling: PersistenceExemption = {
      ...expired,
      id: "dangling",
      sourceFile: "core/no-such-persistence-site.ts",
      expiresOn: "2027-01-01",
    };
    expect(() => scanPersistentStores({
      rootDir: ROOT,
      stores: PERSISTENT_STORES,
      exemptions: [...PERSISTENCE_EXEMPTIONS, dangling],
      today: TODAY,
    })).toThrow(/dangling persistence exemption/);
  });

  it("fails closed when a declared production root is missing", () => {
    const root = tempRepository();
    fs.rmSync(path.join(root, "shared"), { recursive: true, force: true });
    expect(() => discoverSites(root)).toThrow(/persistence scan root is missing: shared/);
  });

  it("detects multiline, imported-alias, destructured-alias, stream, destructive, truncate, and SQLite writes", () => {
    const root = tempRepository();
    fs.writeFileSync(path.join(root, "core", "mutation.ts"), `
      import fs from "node:fs";
      import { writeFile as persist } from "node:fs/promises";
      import Sqlite from "better-sqlite3";
      const { appendFile: persistAppend } = fs;
      fs
        .writeFileSync("state.json", "x");
      await persist("state-2.json", "x");
      persistAppend("events.jsonl", "{}\\n");
      fs.createWriteStream("stream.bin");
      fs.unlinkSync("old-state.json");
      await fs.promises.rm("old-tree", { recursive: true });
      fs.truncateSync("events.jsonl", 0);
      new Sqlite(
        "state.db",
      );
    `, "utf-8");

    const sites = discoverSites(root);
    expect(sites.map((site) => site.kind)).toEqual(expect.arrayContaining([
      "write-file",
      "append-file",
      "database-open",
      "remove-path",
      "truncate-file",
    ]));
    expect(sites.filter((site) => site.kind === "write-file")).toHaveLength(3);
    expect(() => scanPersistentStores({ rootDir: root, stores: [], exemptions: [], today: TODAY }))
      .toThrow(/unregistered persistence site/);
  });

  it("scans desktop host and CLI source while explicitly excluding generated, test, renderer, dist, and native products", () => {
    const root = tempRepository();
    const write = (relativePath: string) => {
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'const fs = require("fs"); fs.writeFileSync("state.json", "x");\n', "utf-8");
    };

    write("desktop/host.cjs");
    write("desktop/src/shared/host.cjs");
    write("cli/host.ts");
    write("desktop/main.bundle.cjs");
    write("desktop/dist-renderer/assets/generated.js");
    write("desktop/dist-splash/assets/generated.js");
    write("desktop/native/generated.cjs");
    write("desktop/src/react/renderer.tsx");
    write("desktop/src/main.tsx");
    write("desktop/src/__tests__/host.test.ts");

    const files = discoverSites(root).map((site) => site.sourceFile);
    expect(files).toEqual(["cli/host.ts", "desktop/host.cjs", "desktop/src/shared/host.cjs"]);
  });

  it("rejects epoch-managed pre-coordinator access without a named additive read projection", () => {
    const earlyRead = {
      ...dummyStore("early-read", "early.json"),
      affectedByEpochMigration: true,
      bootstrapSafety: null,
      firstPossibleOpenPhase: "desktop_bootstrap" as const,
      firstPossibleWritePhase: "runtime_ready" as const,
      preCoordinatorReadProjection: null,
    };
    expect(() => validateRegistry({ stores: [earlyRead], exemptions: [], today: TODAY }))
      .toThrow(/without a read projection/);

    const projected = {
      ...earlyRead,
      preCoordinatorReadProjection: {
        compatibility: "additive-only" as const,
        fields: ["optional_field"],
        reason: "Read one optional field before the coordinator.",
      },
    };
    expect(() => validateRegistry({ stores: [projected], exemptions: [], today: TODAY })).not.toThrow();
  });

  it("requires exact registered paths before bootstrap state may prove an unstamped home is new", () => {
    const invalidSafePath = {
      ...dummyStore("unsafe-bootstrap-proof", "diagnostics/desktop-launch", "tree"),
      affectedByEpochMigration: false,
      firstPossibleOpenPhase: "desktop_bootstrap" as const,
      firstPossibleWritePhase: "desktop_bootstrap" as const,
      bootstrapSafety: {
        compatibility: "epoch-independent" as const,
        reason: "Test-only bootstrap path.",
        unstampedHomeSafePaths: [{ relativePath: "diagnostics/{anything}", kind: "tree" as const }],
      },
    };
    expect(() => validateRegistry({ stores: [invalidSafePath], exemptions: [], today: TODAY }))
      .toThrow(/must be exact/);

    const unregisteredSafePath = {
      ...invalidSafePath,
      bootstrapSafety: {
        ...invalidSafePath.bootstrapSafety,
        unstampedHomeSafePaths: [{ relativePath: "diagnostics/other", kind: "tree" as const }],
      },
    };
    expect(() => validateRegistry({ stores: [unregisteredSafePath], exemptions: [], today: TODAY }))
      .toThrow(/is not registered/);
  });

  it("generates deterministic, repository-relative receipts that match the committed inventory", () => {
    const first = scanPersistentStores({ rootDir: ROOT, today: TODAY });
    const second = scanPersistentStores({ rootDir: ROOT, today: TODAY });
    expect(second).toEqual(first);

    const committed = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    expect(committed).toEqual(first.inventory);
    expect(committed.sourceRoots).toEqual(expect.arrayContaining(["desktop", "cli"]));
    expect(committed.sourceExclusions).toEqual(
      SOURCE_EXCLUSIONS.map(({ id, reason }) => ({ id, reason })),
    );
    const serialized = JSON.stringify(committed);
    expect(serialized).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);
    expect(committed.discoveredSites.every((site: { sourceFile: string }) => !site.sourceFile.includes("\\"))).toBe(true);
  });
});
