const TURN_COMPLETION_NEVER = "never";
const TURN_COMPLETION_WHEN_UNFOCUSED = "when_unfocused";
const TURN_COMPLETION_WHEN_SESSION_UNFOCUSED = "when_session_unfocused";

export const TURN_COMPLETION_NOTIFICATION_MODES = Object.freeze([
  TURN_COMPLETION_NEVER,
  TURN_COMPLETION_WHEN_UNFOCUSED,
  TURN_COMPLETION_WHEN_SESSION_UNFOCUSED,
]);

export function normalizeTurnCompletionNotificationMode(value) {
  return TURN_COMPLETION_NOTIFICATION_MODES.includes(value)
    ? value
    : TURN_COMPLETION_NEVER;
}

export function normalizeNotificationPreferences(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    turnCompletion: normalizeTurnCompletionNotificationMode(source.turnCompletion),
  };
}

export function mergeNotificationPreferences(existing = {}, patch = {}) {
  return normalizeNotificationPreferences({
    ...normalizeNotificationPreferences(existing),
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  });
}
