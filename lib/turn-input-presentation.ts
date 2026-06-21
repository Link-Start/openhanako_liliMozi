import { parseDeferredResultNotification } from "./deferred-result-notification.ts";

export const TURN_INPUT_PRESENTATION_EVENT_TYPE = "turn_input_presentation";

export function buildTurnInputPresentationEvent(message, { deliveryMode = null } = {}) {
  const parsed = parseDeferredResultNotification(message?.content);
  if (!parsed?.taskId) return null;

  return {
    type: TURN_INPUT_PRESENTATION_EVENT_TYPE,
    presentation: {
      kind: "pre_reply_interlude",
      inputKind: "custom_message",
      customType: message?.customType || null,
      taskId: parsed.taskId,
      status: parsed.status === "failed" || parsed.status === "aborted" ? parsed.status : "success",
      resultType: parsed.type || "background-task",
      ...(Object.prototype.hasOwnProperty.call(parsed, "result") ? { result: parsed.result } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(deliveryMode ? { deliveryMode } : {}),
    },
  };
}
