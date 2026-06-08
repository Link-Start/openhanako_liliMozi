import { runSessionSnapshotSideTask } from "../llm/session-snapshot-side-task-runner.ts";
import { scrubPII } from "../pii-guard.ts";

export const MEMORY_REFLECTION_TEMPLATE_VERSION = "memory-reflection.v1";

export function buildMemoryReflectionSuffix({ previousSummary = "", timeZone = "UTC" } = {}) {
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        "Internal memory reflection task.",
        "Read the session prefix above and produce an updated rolling memory summary.",
        "Do not call tools.",
        "Do not address the user.",
        `Time zone: ${timeZone}`,
        previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>` : "<previous-summary>\n\n</previous-summary>",
        "Return only the summary text.",
      ].join("\n\n"),
    }],
  };
}

export async function runMemoryReflection({
  snapshot,
  model,
  cacheKeyParams,
  previousSummary = "",
  sessionId,
  messages = [],
  sourceTimeRange = null,
  timeZone,
  streamFn,
  options = {},
  usageLedger,
  usageContext,
}: Record<string, any> = {}) {
  const sideTask = await runSessionSnapshotSideTask({
    snapshot,
    model,
    cacheKeyParams,
    suffixMessage: buildMemoryReflectionSuffix({ previousSummary, timeZone }),
    streamFn,
    options: {
      ...options,
      toolChoice: "none",
    },
    cacheGroup: "memory.reflection",
    templateVersion: MEMORY_REFLECTION_TEMPLATE_VERSION,
    usageLedger,
    usageContext,
  });

  let summary = sideTask.text.trim();
  const { cleaned, detected } = scrubPII(summary);
  if (detected.length > 0) summary = cleaned.trim();
  const now = new Date().toISOString();
  return {
    summary,
    changed: summary.length > 0,
    data: summary
      ? {
        session_id: sessionId,
        created_at: now,
        updated_at: now,
        summary,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        source_time_range: sourceTimeRange,
        snapshot: "",
        snapshot_at: null,
      }
      : null,
    usage: sideTask.response?.usage || null,
    metadata: sideTask.metadata,
    reason: detected.length > 0 ? "pii_redacted" : "",
  };
}
