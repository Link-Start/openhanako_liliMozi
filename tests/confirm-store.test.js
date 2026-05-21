import { describe, expect, it } from "vitest";
import { ConfirmStore } from "../lib/confirm-store.js";

describe("ConfirmStore", () => {
  it("exposes pending confirmation metadata without resolving it", () => {
    const store = new ConfirmStore();
    const { confirmId } = store.create(
      "tool_action_approval",
      { toolName: "write" },
      "/sessions/a.jsonl",
      60_000,
    );

    expect(store.get(confirmId)).toEqual({
      sessionPath: "/sessions/a.jsonl",
      kind: "tool_action_approval",
      payload: { toolName: "write" },
    });
    expect(store.size).toBe(1);

    store.resolve(confirmId, "rejected");
    expect(store.get(confirmId)).toBeNull();
  });
});
