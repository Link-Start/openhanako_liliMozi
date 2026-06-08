import { lookupKnown } from "../shared/known-models.ts";

export const DEFAULT_SESSION_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh"]);
const OPENAI_XHIGH_MODEL_MARKERS = [
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
];
const ANTHROPIC_MAX_EFFORT_MODEL_MARKERS = [
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "sonnet-4-6",
  "sonnet-4.6",
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function canonicalThinkingLevel(level) {
  const normalized = lower(level);
  if (normalized === "auto") return "medium";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : null;
}

export function normalizeSessionThinkingLevel(level) {
  return canonicalThinkingLevel(level) || DEFAULT_SESSION_THINKING_LEVEL;
}

export function normalizeRequestThinkingLevel(level, fallback = "off") {
  return canonicalThinkingLevel(level)
    || canonicalThinkingLevel(fallback)
    || "off";
}

function idIncludesAny(id, markers) {
  return markers.some((marker) => id.includes(marker));
}

function modelUsesAnthropicEffortControl(model) {
  const provider = lower(model?.provider);
  const api = lower(model?.api);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "anthropic"
    || api === "anthropic-messages"
    || baseUrl.includes("api.anthropic.com");
}

export function modelSupportsAnthropicMaxEffort(model) {
  const id = lower(model?.id);
  return modelUsesAnthropicEffortControl(model)
    && idIncludesAny(id, ANTHROPIC_MAX_EFFORT_MODEL_MARKERS);
}

export function modelSupportsXhigh(model) {
  const id = lower(model?.id);
  const known = lookupKnown(model?.provider, model?.id);
  return model?.xhigh === true
    || known?.xhigh === true
    || idIncludesAny(id, OPENAI_XHIGH_MODEL_MARKERS)
    || modelSupportsAnthropicMaxEffort(model);
}

export function normalizeThinkingLevelForModel(level, model) {
  const normalized = normalizeSessionThinkingLevel(level);
  if (normalized === "xhigh" && !modelSupportsXhigh(model)) return "high";
  return normalized;
}

export function resolveModelDefaultThinkingLevel(model, fallback = DEFAULT_SESSION_THINKING_LEVEL) {
  const modelLevel = typeof model?.defaultThinkingLevel === "string"
    ? model.defaultThinkingLevel
    : fallback;
  return normalizeThinkingLevelForModel(modelLevel, model);
}

export function resolveThinkingLevelForModel(level, model, resolveThinkingLevel = (value) => value) {
  return resolveThinkingLevel(normalizeThinkingLevelForModel(level, model));
}
