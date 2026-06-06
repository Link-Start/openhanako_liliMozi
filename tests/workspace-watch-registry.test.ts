import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorkspaceWatchRegistry } from "../desktop/workspace-watch-registry.cjs";

class FakeWatcher {
  declare close: any;
  declare handlers: any;
  constructor() {
    this.handlers = new Map();
    this.close = vi.fn();
  }

  on(eventName, handler) {
    const handlers = this.handlers.get(eventName) || [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
    return this;
  }

  emit(eventName, ...args) {
    for (const handler of this.handlers.get(eventName) || []) handler(...args);
  }
}

describe("workspace-watch-registry", () => {
  let watchMock;
  let watchers;
  let notified;

  beforeEach(() => {
    watchers = new Map();
    notified = [];
    watchMock = vi.fn((rootPath) => {
      const watcher = new FakeWatcher();
      watchers.set(rootPath, watcher);
      return watcher;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one shallow workspace watcher and notifies subscribers with the affected directory", () => {
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: (subscriberId, payload) => notified.push({ subscriberId, payload }),
      debounceMs: 30,
    });

    expect(registry.watchWorkspace("/workspace", 1)).toBe(true);
    expect(registry.watchWorkspace("/workspace", 2)).toBe(true);
    expect(watchMock).toHaveBeenCalledTimes(1);

    watchers.get("/workspace").emit("all", "add", "/workspace/src/App.tsx");
    vi.advanceTimersByTime(35);

    expect(notified).toEqual([
      {
        subscriberId: 1,
        payload: {
          rootPath: "/workspace",
          changedPath: "/workspace/src/App.tsx",
          affectedDir: "/workspace/src",
          eventType: "add",
        },
      },
      {
        subscriberId: 2,
        payload: {
          rootPath: "/workspace",
          changedPath: "/workspace/src/App.tsx",
          affectedDir: "/workspace/src",
          eventType: "add",
        },
      },
    ]);
  });

  it("ignores heavyweight and hidden workspace paths before they reach the watcher", () => {
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchWorkspace("/workspace", 1);
    const options = watchMock.mock.calls[0][1];

    expect(options.ignored("/workspace/node_modules/pkg/index.js")).toBe(true);
    expect(options.ignored("/workspace/.git/index")).toBe(true);
    expect(options.ignored("/workspace/src/App.tsx")).toBe(false);
  });

  it("limits each watcher to the watched directory so opening a workspace never recursively scans the whole tree", () => {
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    expect(registry.watchWorkspace("/workspace", 1)).toBe(true);
    const options = watchMock.mock.calls[0][1];

    expect(options.depth).toBe(0);
    expect(options.awaitWriteFinish).toBe(false);
    expect(options.ignoreInitial).toBe(true);
  });

  it("removes only the current subscriber and closes the watcher after the last subscriber leaves", () => {
    const registry = createWorkspaceWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchWorkspace("/workspace", 1);
    registry.watchWorkspace("/workspace", 2);

    expect(registry.unwatchWorkspace("/workspace", 1)).toBe(true);
    expect(watchers.get("/workspace").close).not.toHaveBeenCalled();

    expect(registry.unwatchWorkspace("/workspace", 2)).toBe(true);
    expect(watchers.get("/workspace").close).toHaveBeenCalledOnce();
  });
});
