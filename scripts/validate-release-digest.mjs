#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { DIGEST_ASSET_NAME, assertValidReleaseDigest } from "./release-digest-schema.mjs";

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    file: DIGEST_ASSET_NAME,
    tag: env.GITHUB_REF_NAME || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.help && !args.tag) {
    throw new Error("Missing release tag. Pass --tag vX.Y.Z or run from a tag workflow.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validate-release-digest.mjs --tag v0.0.0 [--file ${DIGEST_ASSET_NAME}]

Validates the committed release digest before CI uploads it as a release asset.
`);
}

function tagToVersion(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function validateDigestForTag(digest, tag) {
  assertValidReleaseDigest(digest);
  const expectedVersion = tagToVersion(tag);
  const errors = [];
  if (digest.tag !== tag) {
    errors.push(`digest.tag must be ${tag}, got ${digest.tag}`);
  }
  if (digest.version !== expectedVersion) {
    errors.push(`digest.version must be ${expectedVersion}, got ${digest.version}`);
  }
  if (errors.length > 0) {
    throw new Error(`Release digest does not match tag:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
  return digest;
}

export function readDigestFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return;
  }

  const digest = readDigestFile(args.file);
  validateDigestForTag(digest, args.tag);
  console.log(`Validated ${args.file} for ${args.tag}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}
