import { CORE_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";

export function repairRestoredToolSnapshot(snapshotToolNames, allToolNames, {
  coreToolNames = CORE_TOOL_NAMES,
} = {}) {
  const available = new Set(uniqueToolNames(allToolNames));
  const result = [];
  const seen = new Set();

  for (const name of uniqueToolNames(snapshotToolNames)) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  for (const name of coreToolNames) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  return result;
}

export function sameToolNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}
