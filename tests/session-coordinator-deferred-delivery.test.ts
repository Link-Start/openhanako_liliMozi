import { describe, expect, it, vi } from "vitest";

import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeCoordinator( overrides: any = {}) {
  return new SessionCoordinator({
    agentsDir: "/tmp/fake/agents",
    getAgent: () => ({ id: "test-agent" }),
    getActiveAgentId: () => "test-agent",
    getModels: () => ({}),
    getResourceLoader: () => ({}),
    getSkills: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp",
    agentIdFromSessionPath: () => "test-agent",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getAgents: () => new Map(),
    getActivityStore: () => ({}),
    getAgentById: () => ({ id: "test-agent" }),
    listAgents: () => [],
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    ...overrides,
  });
}

function makeSession({ isStreaming }) {
  return {
    isStreaming,
    sendCustomMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionCoordinator deferred custom delivery", () => {
  it("wakes an idle live session with triggerTurn instead of steer", async () => {
    const order: string[] = [];
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    session.sendCustomMessage.mockImplementation(async () => {
      order.push("send");
    });
    emitEvent.mockImplementation(() => {
      order.push("emit");
    });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord.steerSession = vi.fn();

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result task-id=\"task-1\" status=\"success\" type=\"subagent\">done</hana-background-result>",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(order).toEqual(["emit", "send"]);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
    expect(coord.steerSession).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn_input_presentation",
        presentation: expect.objectContaining({
          kind: "pre_reply_interlude",
          taskId: "task-1",
          status: "success",
          resultType: "subagent",
          deliveryMode: "triggerTurn",
        }),
      }),
      sessionPath,
    );
  });

  it("queues custom delivery as a follow-up when the session is currently streaming", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: true });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result task-id=\"task-follow-up\" status=\"success\" type=\"workflow\">done</hana-background-result>",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "followUp" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { deliverAs: "followUp" },
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn_input_presentation",
        presentation: expect.objectContaining({
          kind: "pre_reply_interlude",
          taskId: "task-follow-up",
          status: "success",
          resultType: "workflow",
          deliveryMode: "followUp",
        }),
      }),
      sessionPath,
    );
  });

  it("cold-loads an unloaded session before delivering the custom message", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/cold.jsonl";
    coord.ensureSessionLoaded = vi.fn(async (sessionPath) => {
      coord.sessions.set(sessionPath, {
        session,
        agentId: "test-agent",
        lastTouchedAt: 0,
      });
      return session;
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(coord.ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
  });

  it("refuses to cold-load archived sessions for custom delivery", async () => {
    const coord = makeCoordinator();
    coord.ensureSessionLoaded = vi.fn();
    const archivedPath = "/tmp/fake/agents/test-agent/sessions/archived/cold.jsonl";

    await expect(
      coord.deliverCustomMessage(archivedPath, {
        customType: "hana-background-result",
        content: "<hana-background-result />",
        display: false,
      }),
    ).rejects.toThrow(/active desktop session/);

    expect(coord.ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it("can deliver a notification without triggering a parent turn", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(
      sessionPath,
      {
        customType: "hana-background-result",
        content: "<hana-background-result />",
        display: false,
      },
      { triggerTurn: false },
    );

    expect(result).toMatchObject({ ok: true, mode: "notifyOnly" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: false },
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn_input_presentation" }),
      expect.anything(),
    );
  });

  it("records non-context custom entries on a live session manager without sending a custom message", () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    (session as any).sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = coord.recordCustomEntry(sessionPath, "hana-deferred-result", {
      taskId: "task-img",
    });

    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "hana-deferred-result",
      { taskId: "task-img" },
    );
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });
});
