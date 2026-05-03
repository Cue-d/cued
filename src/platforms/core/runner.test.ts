import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdapterDefinitionMock, spawnMock } = vi.hoisted(() => ({
  getAdapterDefinitionMock: vi.fn(() => ({
    platform: "slack",
    workerEntrypoint: "/tmp/fake-worker.js",
    autoSync: true,
    workerTimeoutMs: 50,
  })),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./registry.js", () => ({
  getAdapterDefinition: getAdapterDefinitionMock,
}));

import { runAdapter } from "./runner.js";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("adapter runner", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    getAdapterDefinitionMock.mockReturnValue({
      platform: "slack",
      workerEntrypoint: "/tmp/fake-worker.js",
      autoSync: true,
      workerTimeoutMs: 50,
    });
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("surfaces structured worker errors from stdout", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = runAdapter("slack", "workspace-a");
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          error: "Slack API error: rate_limited",
        }),
      ),
    );
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
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...process.execArgv, "/tmp/fake-worker.js"],
      expect.objectContaining({
        detached: true,
      }),
    );
  });

  it("falls back to a TypeScript worker entrypoint when running from source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-adapter-runner-"));
    tempDirs.push(dir);
    const tsWorker = join(dir, "signal-worker.ts");
    writeFileSync(tsWorker, "");

    getAdapterDefinitionMock.mockReturnValue({
      platform: "signal",
      workerEntrypoint: join(dir, "signal-worker.js"),
      autoSync: true,
      workerTimeoutMs: 50,
    });

    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = runAdapter("signal", "default");
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          bundle: {
            sourceAccounts: [],
            rawEvents: [],
          },
        }),
      ),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      sourceAccounts: [],
      rawEvents: [],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...process.execArgv, tsWorker],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });
});
