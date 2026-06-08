import { describe, expect, it } from "vitest";
import {
  classifySessionPermission,
  normalizeSessionPermissionMode,
} from "../core/session-permission-mode.ts";

describe("session permission modes", () => {
  it("normalizes missing and legacy fields", () => {
    expect(normalizeSessionPermissionMode({})).toBe("ask");
    expect(normalizeSessionPermissionMode({ permissionMode: "auto" })).toBe("auto");
    expect(normalizeSessionPermissionMode({ accessMode: "operate" })).toBe("operate");
    expect(normalizeSessionPermissionMode({ accessMode: "read_only" })).toBe("read_only");
    expect(normalizeSessionPermissionMode({ planMode: true })).toBe("read_only");
  });

  it("classifies information and side-effect tools by mode", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "web_search" })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "write" })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "write" })).toMatchObject({
      action: "prompt",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "write" })).toMatchObject({
      action: "review",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "operate", toolName: "write" })).toEqual({ action: "allow" });
  });

  it("treats browser information gathering separately from page actions", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "browser", params: { action: "screenshot" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "browser", params: { action: "click" } })).toMatchObject({
      action: "deny",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "browser", params: { action: "type" } })).toMatchObject({
      action: "prompt",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "browser", params: { action: "type" } })).toMatchObject({
      action: "review",
    });
  });

  it("allows terminal inspection but protects terminal mutation", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "terminal", params: { action: "list" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "terminal", params: { action: "read" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "terminal", params: { action: "start" } })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "terminal", params: { action: "write" } })).toMatchObject({
      action: "prompt",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "terminal", params: { action: "start" } })).toMatchObject({
      action: "review",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "operate", toolName: "terminal", params: { action: "close" } })).toEqual({ action: "allow" });
  });

  it("allows session folder inspection while protecting folder authorization changes", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "session_folders", params: { action: "list" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "session_folders", params: { action: "add" } })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "session_folders", params: { action: "add" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "session_folders", params: { action: "remove" } })).toEqual({ action: "allow" });
  });

  it("blocks subagent tool inside a subagent (anti-recursion), independent of mode", () => {
    // subagent 上下文：subagent 工具被拦，无论什么 mode（防自递归，拦截层而非剥离）
    expect(classifySessionPermission({ mode: "operate", toolName: "subagent", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "subagent", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
    // 非 subagent 上下文：subagent 工具按常规（operate 放行）
    expect(classifySessionPermission({ mode: "operate", toolName: "subagent" })).toEqual({ action: "allow" });
    // subagent 上下文里其它工具不受这条影响：read 放行、write 仍按 mode
    expect(classifySessionPermission({ mode: "operate", toolName: "read", context: { isSubagent: true } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "write", context: { isSubagent: true } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "write", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
  });

  it("blocks the full subagent越权 tool set inside a subagent (memory/lifecycle/fan-out), independent of mode", () => {
    // subagent 不该碰：污染长期记忆 / 管 agent 一生 / 再扇出。即便最宽松的 operate 也拦。
    const BLOCKED = [
      "subagent",         // 防自递归
      "pin_memory", "unpin_memory", "record_experience", // 长期记忆（subagent 不碰）
      "automation", "cron", "channel", "dm", "notify", "install_skill", "update_settings", "session_folders", // agent 生命周期/对外
      "workflow",         // 间接扇出
    ];
    for (const name of BLOCKED) {
      expect(
        classifySessionPermission({ mode: "operate", toolName: name, context: { isSubagent: true } }),
        `${name} 应在 subagent 上下文被拦`,
      ).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
      // 非 subagent 上下文：operate 正常放行（限制仅在 subagent 上下文）
      expect(
        classifySessionPermission({ mode: "operate", toolName: name }),
        `${name} 在普通上下文 operate 应放行`,
      ).toEqual({ action: "allow" });
    }
    // computer 不在禁用集（有全局开关兜底）：subagent 上下文 operate 仍放行
    expect(classifySessionPermission({ mode: "operate", toolName: "computer", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
  });

  it("subagent 没有确认模式：ask/auto 在 subagent 上下文坍缩为 operate（永不挂在确认上）", () => {
    // subagent 上下文 + ask：write 不 prompt，直接放行（坍缩 operate）
    expect(classifySessionPermission({ mode: "ask", toolName: "write", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "ask", toolName: "bash", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    // browser/terminal 的写动作同理（ask 坍缩 operate → 放行，不 prompt）
    expect(classifySessionPermission({ mode: "ask", toolName: "browser", params: { action: "click" }, context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "ask", toolName: "terminal", params: { action: "start" }, context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "write", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "bash", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "browser", params: { action: "click" }, context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    // 非 subagent 上下文：ask 照常 prompt（不受影响）
    expect(classifySessionPermission({ mode: "ask", toolName: "write" }))
      .toMatchObject({ action: "prompt" });
    // subagent + ask 仍挡越权工具（坍缩只影响 ask→operate，不放开禁用集）
    expect(classifySessionPermission({ mode: "ask", toolName: "pin_memory", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
  });
});
