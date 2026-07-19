import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCommittedPersistenceSchemaFingerprint,
  generatePersistenceSchemaFingerprint,
  validateSchemaChangeDeclaration,
  writePersistenceSchemaFingerprint,
} from "../scripts/generate-persistence-schema-fingerprint.mjs";
import {
  PRODUCTION_ROOTS,
  scanPersistentStores,
} from "../scripts/scan-persistent-stores.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINGERPRINT_PATH = path.join(ROOT, "build", "persistence-schema-fingerprint.json");
const INVENTORY_PATH = path.join(ROOT, "build", "persistence-store-inventory.json");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-schema-tripwire-"));
  tempDirs.push(root);
  for (const productionRoot of PRODUCTION_ROOTS) {
    fs.mkdirSync(path.join(root, productionRoot), { recursive: true });
  }
  return root;
}

describe("persistence schema tripwire", () => {
  it("uses real SQLite stores and matches the deterministic committed fingerprint", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const first = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      review: committed.review,
    });
    const second = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      review: committed.review,
    });

    expect(second).toEqual(first);
    expect(committed).toEqual(first);
    expect(first.dataEpoch).toBe(1);
    expect(first.registry.length).toBeGreaterThan(20);
    expect(first.siteMappings.length).toBeGreaterThan(500);
    expect(first.exemptions.length).toBeGreaterThan(0);
    expect(first.inventoryReceipt.sourceRoots).toEqual(expect.arrayContaining(["desktop", "cli"]));
    expect(first.inventoryReceipt.sourceExclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "desktop-generated-bundles" }),
      expect.objectContaining({ id: "desktop-renderer-react" }),
      expect.objectContaining({ id: "source-tests" }),
    ]));

    const manifest = first.schemas.find((entry) => entry.storeId === "session-manifest-sqlite");
    expect(manifest).toMatchObject({
      kind: "sqlite-runtime",
      module: "core/session-manifest/store.ts",
      runtimeSchema: { userVersion: 4 },
    });
    expect(manifest.runtimeSchema.objects.some((entry) => entry.name === "session_manifests")).toBe(true);
    expect(manifest.runtimeSchema.objects.every((entry) => !entry.name.startsWith("sqlite_"))).toBe(true);

    const facts = first.schemas.find((entry) => entry.storeId === "agent-facts-sqlite");
    expect(facts).toMatchObject({
      kind: "sqlite-runtime",
      module: "lib/memory/fact-store.ts",
      runtimeSchema: { userVersion: 2 },
    });
    expect(facts.runtimeSchema.objects.some((entry) => entry.name === "facts_fts")).toBe(true);
    expect(facts.runtimeSchema.objects.every((entry) => !entry.name.startsWith("facts_fts_"))).toBe(true);

    const sessions = first.schemas.find((entry) => entry.storeId === "session-jsonl");
    expect(sessions).toMatchObject({
      kind: "external-versioned",
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.80.3",
      requestedVersion: "0.80.3",
      versionSource: {
        currentSessionVersion: 3,
        declaration: "export const CURRENT_SESSION_VERSION = 3;",
      },
    });
    expect(sessions.packageIntegrity).toMatch(/^sha512-/);
    expect(sessions.extensions.map((entry) => entry.module)).toEqual([
      "core/session-coordinator.ts",
      "core/session-jsonl-file.ts",
    ]);
    expect(sessions.extensions.every((entry) => entry.sourceHash.startsWith("sha256:"))).toBe(true);

    const epochJournal = first.schemas.find((entry) => entry.storeId === "data-epoch-transition-journal");
    expect(epochJournal.protocolModules).toEqual([
      expect.objectContaining({ module: "core/data-epoch-coordinator.ts", sourceHash: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ module: "core/data-epoch-migrations.ts", sourceHash: expect.stringMatching(/^sha256:/) }),
    ]);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);
    expect(first.siteMappings.every((site) => !site.sourceFile.includes("\\"))).toBe(true);
  });

  it("fails with both review paths when a runtime contract source drifts", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "shared/data-epoch.cjs";
    const mutatedSource = `${fs.readFileSync(path.join(ROOT, module), "utf-8")}\n// schema drift mutation\n`;

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[module, mutatedSource]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch[\s\S]*compatible addition[\s\S]*breaking change/);

    const coordinatorModule = "core/data-epoch-coordinator.ts";
    const mutatedCoordinator = `${fs.readFileSync(path.join(ROOT, coordinatorModule), "utf-8")}\n// protocol drift mutation\n`;
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[coordinatorModule, mutatedCoordinator]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it("rejects a repinned payload until the committed review pins that exact payload", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "shared/data-epoch.cjs";
    const mutatedSource = `${fs.readFileSync(path.join(ROOT, module), "utf-8")}\n// reviewed schema mutation\n`;
    const sourceOverrides = new Map([[module, mutatedSource]]);
    const reviewedMutation = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      sourceOverrides,
      review: {
        classification: "compatible",
        compatibilityReason: "The mutation represents a reviewed source-only compatibility change.",
      },
    });
    const repinnedWithoutReview = {
      ...reviewedMutation,
      review: committed.review,
    };

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: repinnedWithoutReview,
      inventory,
      sourceOverrides,
    })).rejects.toThrow(/schema review does not pin the committed payloadFingerprint/);

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: reviewedMutation,
      inventory,
      sourceOverrides,
    })).resolves.toEqual(reviewedMutation);
  });

  it("treats a runtime DATA_EPOCH change as payload drift that needs a new review", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      currentDataEpoch: 2,
      inventory,
    })).rejects.toThrow(/persistence schema fingerprint mismatch[\s\S]*compatible addition[\s\S]*breaking change/);

    await expect(generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      currentDataEpoch: 2,
      inventory,
      review: committed.review,
    })).rejects.toThrow(/schema review pins[\s\S]*generated payload/);
  });

  it("requires an epoch-changing write to carry the exact breaking transition review", async () => {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-schema-write-review-"));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, "persistence-schema-fingerprint.json");

    await writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 1,
      inventory,
      review: {
        classification: "compatible",
        compatibilityReason: "Record the current runtime schemas without changing persisted behavior.",
      },
    });

    await expect(writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 2,
      inventory,
      review: {
        classification: "compatible",
        compatibilityReason: "This must not be allowed to disguise an epoch transition.",
      },
    })).rejects.toThrow(/DATA_EPOCH changed from 1 to 2[\s\S]*breaking[\s\S]*sourceDataEpoch=1[\s\S]*targetDataEpoch=2/);

    const written = await writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 2,
      inventory,
      review: {
        classification: "breaking",
        sourceDataEpoch: 1,
        targetDataEpoch: 2,
        affectedStores: ["session-manifest-sqlite"],
        checkpointPolicy: "Checkpoint the affected store before migration.",
        restorePolicy: "Restore through the owning store after compatibility validation.",
      },
    });
    expect(written.fingerprint).toMatchObject({
      dataEpoch: 2,
      review: {
        classification: "breaking",
        sourceDataEpoch: 1,
        targetDataEpoch: 2,
      },
    });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf-8"))).toEqual(written.fingerprint);
  });

  it("keeps the unregistered-write mutation as the first tripwire", () => {
    const root = temporaryRepository();
    fs.writeFileSync(path.join(root, "core", "unregistered-schema-write.ts"), `
      import fs from "node:fs";
      fs.writeFileSync("unregistered-state.json", "{}");
    `, "utf-8");

    expect(() => scanPersistentStores({
      rootDir: root,
      stores: [],
      exemptions: [],
      today: "2026-07-13",
    })).toThrow(/unregistered persistence site/);
  });

  it("requires a complete breaking declaration and binds it to the landed DATA_EPOCH", async () => {
    expect(() => validateSchemaChangeDeclaration({ classification: "breaking" }, { currentDataEpoch: 2 }))
      .toThrow(
        /source DATA_EPOCH[\s\S]*target DATA_EPOCH[\s\S]*affected stores[\s\S]*checkpoint policy[\s\S]*restore policy[\s\S]*compatible addition[\s\S]*breaking change/,
      );

    expect(validateSchemaChangeDeclaration({
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
      affectedStores: ["session-manifest-sqlite"],
      checkpointPolicy: "Checkpoint the store before migration.",
      restorePolicy: "Restore through the owning store after compatibility validation.",
    }, { currentDataEpoch: 2 })).toMatchObject({
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
    });

    const completeBreakingReview = {
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
      affectedStores: ["session-manifest-sqlite"],
      checkpointPolicy: "Checkpoint the store before migration.",
      restorePolicy: "Restore through the owning store after compatibility validation.",
    };
    expect(() => validateSchemaChangeDeclaration(completeBreakingReview, { currentDataEpoch: 1 }))
      .toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);
    expect(() => validateSchemaChangeDeclaration(completeBreakingReview, { currentDataEpoch: 3 }))
      .toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);

    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const landedBreakingFingerprint = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      currentDataEpoch: 2,
      inventory,
      review: completeBreakingReview,
    });
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 2,
      inventory,
    })).resolves.toEqual(landedBreakingFingerprint);
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 1,
      inventory,
    })).rejects.toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 3,
      inventory,
    })).rejects.toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);

    expect(() => validateSchemaChangeDeclaration({ classification: "compatible" }))
      .toThrow(/compatibility reasoning[\s\S]*compatible addition[\s\S]*breaking change/);
  });
});
