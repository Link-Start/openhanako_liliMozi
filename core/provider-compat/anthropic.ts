/**
 * Anthropic Messages prompt-cache compatibility layer.
 *
 * Chat requests normally get cache_control from Pi SDK before this layer runs.
 * Utility requests are direct HTTP calls, so this module makes the same marker
 * contract available through normalizeProviderPayload.
 */

import { modelSupportsAnthropicMaxEffort } from "../session-thinking-level.ts";

const CACHE_CONTROL = { type: "ephemeral" };
const MAX_EFFORT_MIN_OUTPUT_TOKENS = 64000;

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getModelOutputLimit(model) {
  return positiveInteger(model?.maxTokens || model?.maxOutput);
}

function isImplicitAnthropicOutputCap(value, model) {
  const modelLimit = getModelOutputLimit(model);
  if (!modelLimit) return false;
  return positiveInteger(value) === Math.floor(modelLimit / 3);
}

function hasCacheControl(block) {
  return Boolean(block && typeof block === "object" && block.cache_control);
}

function shouldCacheContentBlock(block) {
  return block && typeof block === "object"
    && (block.type === "text" || block.type === "image" || block.type === "tool_result");
}

function withCacheControl(block) {
  if (!shouldCacheContentBlock(block) || hasCacheControl(block)) return block;
  return { ...block, cache_control: { ...CACHE_CONTROL } };
}

function normalizeSystem(system) {
  if (typeof system === "string") {
    return {
      value: [{ type: "text", text: system, cache_control: { ...CACHE_CONTROL } }],
      changed: true,
    };
  }

  if (!Array.isArray(system)) {
    return { value: system, changed: false };
  }

  let lastIndex = -1;
  for (let i = system.length - 1; i >= 0; i--) {
    if (system[i]?.type === "text") {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex < 0 || hasCacheControl(system[lastIndex])) {
    return { value: system, changed: false };
  }

  const next = system.slice();
  next[lastIndex] = withCacheControl(system[lastIndex]);
  return { value: next, changed: true };
}

function normalizeUserMessage(message) {
  if (!message || message.role !== "user") {
    return { value: message, changed: false, cacheable: false };
  }

  if (typeof message.content === "string") {
    if (message.content.trim().length === 0) {
      return { value: message, changed: false, cacheable: false };
    }
    return {
      value: {
        ...message,
        content: [{
          type: "text",
          text: message.content,
          cache_control: { ...CACHE_CONTROL },
        }],
      },
      changed: true,
      cacheable: true,
    };
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    return { value: message, changed: false, cacheable: false };
  }

  const blockIndex = message.content.length - 1;
  const lastBlock = message.content[blockIndex];
  if (!shouldCacheContentBlock(lastBlock)) {
    return { value: message, changed: false, cacheable: false };
  }
  if (hasCacheControl(lastBlock)) {
    return { value: message, changed: false, cacheable: true };
  }

  const nextContent = message.content.slice();
  nextContent[blockIndex] = withCacheControl(lastBlock);
  return {
    value: { ...message, content: nextContent },
    changed: true,
    cacheable: true,
  };
}

function normalizeRecentUserMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { value: messages, changed: false };
  }

  let next = messages;
  let changed = false;
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const result = normalizeUserMessage(next[i]);
    if (!result.cacheable) continue;
    marked++;
    if (result.changed) {
      if (next === messages) next = messages.slice();
      next[i] = result.value;
      changed = true;
    }
  }
  return { value: next, changed };
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.api) !== "anthropic-messages") return false;
  if (lower(model.provider) === "anthropic") return true;
  if (lower(model.id).startsWith("claude-")) return true;
  return model.compat?.cacheControlFormat === "anthropic";
}

function shouldUseAnthropicMaxEffort(model, options) {
  return options?.reasoningLevel === "xhigh" && modelSupportsAnthropicMaxEffort(model);
}

function withMaxEffort(payload) {
  const next = { ...payload };
  const thinking = payload.thinking && typeof payload.thinking === "object"
    ? payload.thinking
    : {};
  if (thinking.type !== "adaptive") {
    next.thinking = {
      type: "adaptive",
      display: thinking.display || "summarized",
    };
  }
  next.output_config = { ...(payload.output_config || {}), effort: "max" };
  return next;
}

function withMaxEffortOutputBudget(payload, model, options) {
  const current = positiveInteger(payload.max_tokens);
  const modelLimit = getModelOutputLimit(model);
  if (!current || !modelLimit) return payload;
  if (!isImplicitAnthropicOutputCap(current, model)) return payload;
  const source = lower(options?.outputBudgetSource || options?.maxTokensSource);
  if (source === "user" || source === "system") return payload;

  const target = Math.min(modelLimit, MAX_EFFORT_MIN_OUTPUT_TOKENS);
  if (current >= target) return payload;
  return { ...payload, max_tokens: target };
}

function normalizeMaxEffort(payload, model, options) {
  if (!shouldUseAnthropicMaxEffort(model, options)) return payload;
  return withMaxEffortOutputBudget(withMaxEffort(payload), model, options);
}

export function apply(payload, model, options = {}) {
  let result = payload;

  if (Object.prototype.hasOwnProperty.call(payload, "system")) {
    const system = normalizeSystem(payload.system);
    if (system.changed) result = { ...result, system: system.value };
  }

  const messages = normalizeRecentUserMessages(result.messages);
  if (messages.changed) result = { ...result, messages: messages.value };

  result = normalizeMaxEffort(result, model, options);

  return result;
}
