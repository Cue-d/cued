import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../adapters/registry.js", () => ({
  getAdapterDefinition: vi.fn(() => ({
    platform: "slack",
    workerEntrypoint: "/tmp/fake-worker.js",
    autoSync: true,
    workerTimeoutMs: 50,
  })),
}));

import { runAdapter } from "../adapters/runner.js";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("adapter runner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("surfaces structured worker errors from stdout", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = runAdapter("slack", "workspace-a");
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      ok: false,
      error: "Slack API error: rate_limited",
    })));
    child.emit("close", 1);

    await expect(promise).rejects.toThrow("Slack API error: rate_limited");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("times out hung workers and kills the child process", async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = runAdapter("slack", "workspace-a");
    promise.catch(() => undefined);
    const assertion = expect(promise).rejects.toThrow(
      "Adapter worker timed out after 50ms for platform 'slack' account 'workspace-a'",
    );
    await vi.advanceTimersByTimeAsync(60);

    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
