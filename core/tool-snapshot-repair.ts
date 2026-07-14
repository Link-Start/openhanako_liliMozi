import { CORE_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";

const LEGACY_TOOL_ALIASES: Record<string, string[]> = {
  bash: ["exec_command"],
  terminal: ["exec_command", "write_stdin"],
};

function mappedToolNames(name) {
  return LEGACY_TOOL_ALIASES[name] || [name];
}

/**
 * Repairs the runtime-active subset while preserving a normalized copy of the
 * frozen contract. A missing handler may be a transient plugin outage, so
 * restore must not turn current availability into persisted history.
 */
export function repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, {
  coreToolNames = CORE_TOOL_NAMES,
} = {}) {
  const available = new Set(uniqueToolNames(allToolNames));
  const toolNames = [];
  const contractToolNames = [];
  const droppedToolNames = [];
  const seen = new Set();
  const seenContract = new Set();
  const seenSnapshotNames = new Set();

  for (const name of uniqueToolNames(snapshotToolNames)) {
    if (seenSnapshotNames.has(name)) continue;
    seenSnapshotNames.add(name);
    const mappedNames = mappedToolNames(name);
    const kept = mappedNames.filter((mapped) => available.has(mapped));
    if (!kept.length) {
      droppedToolNames.push(name);
    }
    for (const mapped of mappedNames) {
      if (!seenContract.has(mapped)) {
        seenContract.add(mapped);
        contractToolNames.push(mapped);
      }
      if (!available.has(mapped)) continue;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      toolNames.push(mapped);
    }
  }

  for (const name of coreToolNames) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    toolNames.push(name);
    if (!seenContract.has(name)) {
      seenContract.add(name);
      contractToolNames.push(name);
    }
  }

  return { toolNames, contractToolNames, droppedToolNames };
}

export function repairRestoredToolSnapshot(snapshotToolNames, allToolNames, options = {}) {
  return repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, options).toolNames;
}

export function sameToolNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}
