import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scanPersistentStores } from "./scan-persistent-stores.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
export const FINGERPRINT_PATH = "build/persistence-schema-fingerprint.json";

const PI_SESSION_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SESSION_VERSION_MODULE = "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

export const SCHEMA_CHANGE_GUIDANCE = [
  "compatible addition",
  "→ record compatibility reasoning",
  "→ update the store-local schema contract",
  "→ repin the persistence schema fingerprint",
  "",
  "breaking change",
  "→ declare source and target DATA_EPOCH values",
  "→ register the migration in the coordinated migration batch",
  "→ declare affected stores plus checkpoint and restore policy",
  "→ repin the persistence schema fingerprint",
].join("\n");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeRepositoryPath(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`persistence schema source must be a repository-relative path: ${relativePath}`);
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`persistence schema source must not be absolute: ${relativePath}`);
  }
  return normalized;
}

function sourceOverride(sourceOverrides, relativePath) {
  if (!sourceOverrides) return undefined;
  if (sourceOverrides instanceof Map) return sourceOverrides.get(relativePath);
  if (Object.prototype.hasOwnProperty.call(sourceOverrides, relativePath)) {
    return sourceOverrides[relativePath];
  }
  return undefined;
}

function readRepositorySource(rootDir, relativePath, sourceOverrides) {
  const sourcePath = normalizeRepositoryPath(relativePath);
  const override = sourceOverride(sourceOverrides, sourcePath);
  if (override !== undefined) return Buffer.from(String(override), "utf-8");

  const absolutePath = path.resolve(rootDir, ...sourcePath.split("/"));
  const relativeToRoot = path.relative(rootDir, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error(`persistence schema source escapes repository root: ${sourcePath}`);
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`persistence schema source is missing: ${sourcePath}`);
  }
  return fs.readFileSync(absolutePath);
}

function sourceContract(rootDir, schemaSource, sourceOverrides) {
  const module = normalizeRepositoryPath(schemaSource.module);
  return {
    contract: schemaSource.contract,
    module,
    sourceHash: sha256(readRepositorySource(rootDir, module, sourceOverrides)),
  };
}

function resolveCurrentDataEpoch(rootDir, suppliedEpoch) {
  if (suppliedEpoch !== undefined) {
    if (!Number.isInteger(suppliedEpoch) || suppliedEpoch < 1) {
      throw new Error("current DATA_EPOCH must be a positive integer");
    }
    return suppliedEpoch;
  }
  const requireFromRepository = createRequire(path.join(rootDir, "scripts", "persistence-epoch-loader.cjs"));
  const versions = requireFromRepository(path.join(rootDir, "shared", "contract-versions.cjs"));
  if (!Number.isInteger(versions.DATA_EPOCH) || versions.DATA_EPOCH < 1) {
    throw new Error("shared/contract-versions.cjs must export a positive integer DATA_EPOCH");
  }
  return versions.DATA_EPOCH;
}

function normalizeSql(sql) {
  return String(sql || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function readSqliteRuntimeSchema(db, { excludeObject = () => false } = {}) {
  const rows = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all();
  return {
    objects: rows
      .filter((row) => !excludeObject(row))
      .map((row) => ({
        name: row.name,
        sql: normalizeSql(row.sql),
        tableName: row.tableName,
        type: row.type,
      })),
    userVersion: Number(db.pragma("user_version", { simple: true })),
  };
}

async function withTemporaryDatabase(prefix, createStore, inspectStore) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let store = null;
  try {
    store = await createStore(tempDir);
    return inspectStore(store);
  } finally {
    try {
      store?.close?.();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function sessionManifestSchema(rootDir) {
  const modulePath = "core/session-manifest/store.ts";
  const runtime = await import(pathToFileURL(path.join(rootDir, ...modulePath.split("/"))).href);
  return withTemporaryDatabase(
    "hana-session-manifest-schema-",
    (tempDir) => new runtime.SessionManifestStore({ dbPath: path.join(tempDir, "session-manifest.db") }),
    (store) => readSqliteRuntimeSchema(store.db),
  );
}

async function factStoreSchema(rootDir) {
  const modulePath = "lib/memory/fact-store.ts";
  const runtime = await import(pathToFileURL(path.join(rootDir, ...modulePath.split("/"))).href);
  return withTemporaryDatabase(
    "hana-facts-schema-",
    (tempDir) => new runtime.FactStore(path.join(tempDir, "facts.db")),
    (store) => readSqliteRuntimeSchema(store.db, {
      excludeObject: (row) => row.name.startsWith("facts_fts_") || row.tableName.startsWith("facts_fts_"),
    }),
  );
}

async function sqliteContract(rootDir, store, sourceOverrides) {
  let runtimeSchema;
  if (store.id === "session-manifest-sqlite") {
    runtimeSchema = await sessionManifestSchema(rootDir);
  } else if (store.id === "agent-facts-sqlite") {
    runtimeSchema = await factStoreSchema(rootDir);
  } else {
    throw new Error(
      `SQLite store ${store.id} has no runtime introspector. Add one that opens the real store; do not copy DDL into the fingerprint generator.`,
    );
  }

  return {
    contract: store.schemaSource.contract,
    kind: "sqlite-runtime",
    module: normalizeRepositoryPath(store.schemaSource.module),
    runtimeSchema,
    sourceHash: sha256(readRepositorySource(rootDir, store.schemaSource.module, sourceOverrides)),
    storeId: store.id,
  };
}

function parseExtensionModule(extension) {
  const match = String(extension).match(/^([^\s]+\.(?:cjs|js|mjs|ts|tsx))(?:\s|$)/);
  if (!match) {
    throw new Error(`external schema extension must start with a repository source path: ${extension}`);
  }
  return normalizeRepositoryPath(match[1]);
}

async function piSessionContract(rootDir, store, sourceOverrides) {
  const schemaSource = store.schemaSource;
  if (schemaSource.packageName !== PI_SESSION_PACKAGE) {
    throw new Error(`unsupported external persistence schema package: ${schemaSource.packageName}`);
  }

  const lockfile = normalizeRepositoryPath(String(schemaSource.lockfile).split(/\s+/)[0]);
  const lock = JSON.parse(readRepositorySource(rootDir, lockfile, sourceOverrides).toString("utf-8"));
  const lockEntry = lock.packages?.[`node_modules/${schemaSource.packageName}`];
  if (!lockEntry?.version || !lockEntry?.integrity) {
    throw new Error(`package lock entry lacks exact version/integrity: ${schemaSource.packageName}`);
  }

  const packageJson = JSON.parse(readRepositorySource(rootDir, "package.json", sourceOverrides).toString("utf-8"));
  const requestedVersion = packageJson.dependencies?.[schemaSource.packageName];
  if (requestedVersion !== lockEntry.version) {
    throw new Error(
      `${schemaSource.packageName} must be exact and match package-lock.json: requested ${requestedVersion}, locked ${lockEntry.version}`,
    );
  }

  const versionSourceText = readRepositorySource(rootDir, PI_SESSION_VERSION_MODULE, sourceOverrides).toString("utf-8");
  const declaration = versionSourceText.match(/export const CURRENT_SESSION_VERSION\s*=\s*\d+;/)?.[0];
  if (!declaration) {
    throw new Error(`CURRENT_SESSION_VERSION declaration is missing from ${PI_SESSION_VERSION_MODULE}`);
  }
  const declaredVersion = Number(declaration.match(/\d+/)?.[0]);
  const runtime = await import(PI_SESSION_PACKAGE);
  if (runtime.CURRENT_SESSION_VERSION !== declaredVersion) {
    throw new Error(
      `Pi CURRENT_SESSION_VERSION source/runtime mismatch: source ${declaredVersion}, runtime ${runtime.CURRENT_SESSION_VERSION}`,
    );
  }

  const extensions = schemaSource.extensions
    .map((extension) => {
      const module = parseExtensionModule(extension);
      return {
        contract: extension,
        module,
        sourceHash: sha256(readRepositorySource(rootDir, module, sourceOverrides)),
      };
    })
    .sort((left, right) => left.module.localeCompare(right.module));

  return {
    extensions,
    kind: "external-versioned",
    lockfile,
    packageName: schemaSource.packageName,
    packageVersion: lockEntry.version,
    packageIntegrity: lockEntry.integrity,
    requestedVersion,
    storeId: store.id,
    versionSource: {
      currentSessionVersion: runtime.CURRENT_SESSION_VERSION,
      declaration,
      declarationHash: sha256(declaration),
      module: PI_SESSION_VERSION_MODULE,
    },
  };
}

async function schemaEntry(rootDir, store, sourceOverrides) {
  let entry;
  switch (store.schemaSource.kind) {
    case "sqlite-runtime":
      entry = await sqliteContract(rootDir, store, sourceOverrides);
      break;
    case "runtime-contract":
    case "directory-contract":
      entry = {
        ...sourceContract(rootDir, store.schemaSource, sourceOverrides),
        kind: store.schemaSource.kind,
        storeId: store.id,
      };
      break;
    case "external-versioned":
      entry = await piSessionContract(rootDir, store, sourceOverrides);
      break;
    case "narrow-exemption":
      entry = {
        expiresOn: store.schemaSource.expiresOn,
        kind: "narrow-exemption",
        reason: store.schemaSource.reason,
        storeId: store.id,
      };
      break;
    default:
      throw new Error(`unsupported persistence schema source on ${store.id}: ${store.schemaSource.kind}`);
  }
  const protocolModules = (store.protocolModules || [])
    .map((module) => ({
      module: normalizeRepositoryPath(module),
      sourceHash: sha256(readRepositorySource(rootDir, module, sourceOverrides)),
    }))
    .sort((left, right) => left.module.localeCompare(right.module));
  return protocolModules.length > 0 ? { ...entry, protocolModules } : entry;
}

function siteMapping(site) {
  return {
    exemptionId: site.exemptionId,
    kind: site.kind,
    line: site.line,
    reason: site.reason,
    sourceFile: normalizeRepositoryPath(site.sourceFile),
    storeId: site.storeId,
  };
}

function assertPortableFingerprint(value) {
  const visit = (current, trail = "fingerprint") => {
    if (typeof current === "string") {
      const pathField = /(?:module|ownerModule|sourceFile|sourceRoots|lockfile|pathPattern|pathPatterns)(?:\[\d+\])?$/.test(trail);
      if (/^(?:\/|[A-Za-z]:[\\/])/.test(current) || (pathField && current.includes("\\"))) {
        throw new Error(`${trail} contains a machine-specific or non-POSIX path: ${current}`);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${trail}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) visit(item, `${trail}.${key}`);
    }
  };
  visit(value);
}

async function generatePersistenceSchemaPayload({
  rootDir = REPOSITORY_ROOT,
  inventory: suppliedInventory,
  sourceOverrides,
  currentDataEpoch,
} = {}) {
  const dataEpoch = resolveCurrentDataEpoch(rootDir, currentDataEpoch);
  const inventory = suppliedInventory ?? scanPersistentStores({ rootDir }).inventory;
  const schemas = [];
  for (const store of inventory.stores) {
    schemas.push(await schemaEntry(rootDir, store, sourceOverrides));
  }
  schemas.sort((left, right) => left.storeId.localeCompare(right.storeId));

  const payload = {
    dataEpoch,
    exemptions: [...inventory.exemptions].sort((left, right) => left.id.localeCompare(right.id)),
    generatedBy: "scripts/generate-persistence-schema-fingerprint.mjs",
    inventoryReceipt: {
      generatedBy: inventory.generatedBy,
      sourceExclusions: [...(inventory.sourceExclusions ?? [])],
      sourceRoots: [...inventory.sourceRoots],
      version: inventory.version,
    },
    registry: [...inventory.stores].sort((left, right) => left.id.localeCompare(right.id)),
    schemas,
    siteMappings: inventory.discoveredSites
      .map(siteMapping)
      .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile)
        || left.line - right.line
        || left.kind.localeCompare(right.kind)),
    version: 1,
  };
  const payloadFingerprint = sha256(canonicalJson(payload));
  const result = canonicalize({ ...payload, payloadFingerprint });
  assertPortableFingerprint(result);
  return result;
}

function reviewedFingerprint(payload, review, { currentDataEpoch = 1 } = {}) {
  validateSchemaChangeDeclaration(review, { currentDataEpoch });
  if (review.payloadFingerprint && review.payloadFingerprint !== payload.payloadFingerprint) {
    throw new Error(
      `schema review pins ${review.payloadFingerprint}, but generated payload is ${payload.payloadFingerprint}\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  return canonicalize({
    ...payload,
    review: {
      ...review,
      payloadFingerprint: payload.payloadFingerprint,
    },
  });
}

export async function generatePersistenceSchemaFingerprint({
  review,
  currentDataEpoch,
  rootDir = REPOSITORY_ROOT,
  ...options
} = {}) {
  if (!review) {
    throw new Error(
      `persistence schema fingerprint generation requires an explicit compatible or breaking review\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  const payload = await generatePersistenceSchemaPayload({ rootDir, currentDataEpoch, ...options });
  return reviewedFingerprint(payload, review, {
    currentDataEpoch: payload.dataEpoch,
  });
}

function validateCommittedReview(committed, { currentDataEpoch = 1 } = {}) {
  if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
    throw new Error(`committed persistence schema fingerprint must be an object\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  validateSchemaChangeDeclaration(committed.review, { currentDataEpoch });

  const { review, payloadFingerprint, ...payloadBody } = committed;
  const recomputedPayloadFingerprint = sha256(canonicalJson(payloadBody));
  if (payloadFingerprint !== recomputedPayloadFingerprint) {
    throw new Error(
      `committed payloadFingerprint is stale: recorded ${payloadFingerprint || "missing"}, `
      + `recomputed ${recomputedPayloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  if (review.payloadFingerprint !== payloadFingerprint) {
    throw new Error(
      `schema review does not pin the committed payloadFingerprint: review ${review.payloadFingerprint || "missing"}, `
      + `payload ${payloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  return canonicalize({ ...payloadBody, payloadFingerprint });
}

export async function writePersistenceSchemaFingerprint({
  rootDir = REPOSITORY_ROOT,
  outputPath = FINGERPRINT_PATH,
  review,
  currentDataEpoch,
  ...options
} = {}) {
  const outputIsAbsolute = path.isAbsolute(outputPath);
  const normalizedOutput = outputIsAbsolute ? toPosix(outputPath) : normalizeRepositoryPath(outputPath);
  const absoluteOutput = outputIsAbsolute
    ? outputPath
    : path.join(rootDir, ...normalizedOutput.split("/"));
  const payload = await generatePersistenceSchemaPayload({ rootDir, currentDataEpoch, ...options });
  const resolvedDataEpoch = payload.dataEpoch;
  let selectedReview = review;
  if (fs.existsSync(absoluteOutput)) {
    const existing = JSON.parse(fs.readFileSync(absoluteOutput, "utf-8"));
    const existingPayload = validateCommittedReview(existing, { currentDataEpoch: existing.dataEpoch });
    const epochChanged = existingPayload.dataEpoch !== payload.dataEpoch;
    if (epochChanged) {
      if (selectedReview?.classification !== "breaking"
        || selectedReview.sourceDataEpoch !== existingPayload.dataEpoch
        || selectedReview.targetDataEpoch !== payload.dataEpoch) {
        throw new Error(
          `DATA_EPOCH changed from ${existingPayload.dataEpoch} to ${payload.dataEpoch}; the new review must be `
          + `breaking with sourceDataEpoch=${existingPayload.dataEpoch} and targetDataEpoch=${payload.dataEpoch}\n\n`
          + SCHEMA_CHANGE_GUIDANCE,
        );
      }
    } else if (selectedReview?.classification === "breaking") {
      throw new Error(
        `breaking schema review requires a DATA_EPOCH bump; current payload remains at ${payload.dataEpoch}\n\n`
        + SCHEMA_CHANGE_GUIDANCE,
      );
    }
    if (!selectedReview && existingPayload.payloadFingerprint !== payload.payloadFingerprint) {
      throw new Error(
        `persistence schema payload changed from ${existingPayload.payloadFingerprint} to ${payload.payloadFingerprint}; `
        + `an explicit compatible or breaking review is required\n\n${SCHEMA_CHANGE_GUIDANCE}`,
      );
    }
    selectedReview ??= existing.review;
  } else if (selectedReview?.classification && selectedReview.classification !== "compatible") {
    throw new Error(
      `initial persistence schema baseline must use an explicit compatible review\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  if (!selectedReview) {
    throw new Error(
      `initial persistence schema fingerprint generation requires an explicit compatible or breaking review\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  const fingerprint = reviewedFingerprint(payload, selectedReview, { currentDataEpoch: resolvedDataEpoch });
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, stableJson(fingerprint), "utf-8");
  return { fingerprint, outputPath: normalizedOutput };
}

export async function assertCommittedPersistenceSchemaFingerprint({
  rootDir = REPOSITORY_ROOT,
  committedFingerprint,
  committedPath = FINGERPRINT_PATH,
  currentDataEpoch,
  ...options
} = {}) {
  const expected = committedFingerprint ?? JSON.parse(
    readRepositorySource(rootDir, committedPath).toString("utf-8"),
  );
  const resolvedDataEpoch = resolveCurrentDataEpoch(rootDir, currentDataEpoch);
  const expectedPayload = validateCommittedReview(expected, { currentDataEpoch: resolvedDataEpoch });
  const actualPayload = await generatePersistenceSchemaPayload({
    rootDir,
    currentDataEpoch: resolvedDataEpoch,
    ...options,
  });
  if (canonicalJson(actualPayload) !== canonicalJson(expectedPayload)) {
    throw new Error(
      `persistence schema fingerprint mismatch: committed ${expectedPayload.payloadFingerprint}, `
      + `generated ${actualPayload.payloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  return expected;
}

export function validateSchemaChangeDeclaration(declaration, { currentDataEpoch = 1 } = {}) {
  if (!declaration || !["compatible", "breaking"].includes(declaration.classification)) {
    throw new Error(`schema change classification must be compatible or breaking\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  if (declaration.classification === "compatible") {
    if (typeof declaration.compatibilityReason !== "string" || !declaration.compatibilityReason.trim()) {
      throw new Error(`compatible schema declaration is missing compatibility reasoning\n\n${SCHEMA_CHANGE_GUIDANCE}`);
    }
    return declaration;
  }

  const missing = [];
  if (!Number.isInteger(declaration.sourceDataEpoch) || declaration.sourceDataEpoch < 1) {
    missing.push("source DATA_EPOCH");
  }
  if (!Number.isInteger(declaration.targetDataEpoch)
    || !Number.isInteger(declaration.sourceDataEpoch)
    || declaration.targetDataEpoch <= declaration.sourceDataEpoch) {
    missing.push("target DATA_EPOCH greater than source DATA_EPOCH");
  } else if (currentDataEpoch !== declaration.targetDataEpoch) {
    missing.push("current DATA_EPOCH equal to target DATA_EPOCH");
  }
  if (!Array.isArray(declaration.affectedStores)
    || declaration.affectedStores.length === 0
    || declaration.affectedStores.some((storeId) => typeof storeId !== "string" || !storeId.trim())) {
    missing.push("affected stores");
  }
  if (typeof declaration.checkpointPolicy !== "string" || !declaration.checkpointPolicy.trim()) {
    missing.push("checkpoint policy");
  }
  if (typeof declaration.restorePolicy !== "string" || !declaration.restorePolicy.trim()) {
    missing.push("restore policy");
  }
  if (missing.length > 0) {
    throw new Error(`breaking schema declaration is incomplete: missing ${missing.join(", ")}\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  return declaration;
}

function parseCliReview(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected schema fingerprint argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`schema fingerprint argument requires a value: ${key}`);
    }
    index += 1;
    const existing = values.get(key) || [];
    existing.push(value);
    values.set(key, existing);
  }

  const classification = values.get("--classification")?.at(-1);
  if (!classification) {
    if (values.size > 0) throw new Error("--classification is required when supplying schema review arguments");
    return undefined;
  }
  const review = { classification };
  if (classification === "compatible") {
    review.compatibilityReason = values.get("--compatibility-reason")?.at(-1);
  } else if (classification === "breaking") {
    review.sourceDataEpoch = Number(values.get("--source-data-epoch")?.at(-1));
    review.targetDataEpoch = Number(values.get("--target-data-epoch")?.at(-1));
    review.affectedStores = (values.get("--affected-store") || [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    review.checkpointPolicy = values.get("--checkpoint-policy")?.at(-1);
    review.restorePolicy = values.get("--restore-policy")?.at(-1);
  }
  return review;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const review = parseCliReview(process.argv.slice(2));
  const { fingerprint, outputPath } = await writePersistenceSchemaFingerprint({ review });
  process.stdout.write(
    `persistence schema fingerprint: ${fingerprint.payloadFingerprint}\n${toPosix(outputPath)}\n`,
  );
}
