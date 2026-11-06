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

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith("/power-state.json")) throw new Error("No host in runner tests");
      return fs.readFileSync(...args);
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./registry.js", () => ({
  getAdapterDefinition: getAdapterDefinitionMock,
}));

import { SyncInterruptedBySleep } from "../../core/system-sleep.js";
import { AdapterWorkerError, runAdapter } from "./runner.js";

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

  it("preserves structured worker error codes across the process boundary", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = runAdapter("slack", "workspace-a");
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          error: "Authentication failed: 302 Found",
          errorCode: "auth_invalid",
        }),
      ),
    );
    child.emit("close", 1);

    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(AdapterWorkerError);
    expect(error).toMatchObject({
      message: "Authentication failed: 302 Found",
      code: "auth_invalid",
    });
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

  it("requeues suspension instead of reporting a worker timeout", async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const promise = runAdapter("slack", "workspace-a");
    const assertion = expect(promise).rejects.toBeInstanceOf(SyncInterruptedBySleep);
    // Time passes while neither the watchdog nor the worker gets CPU time.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a successful bundle arriving after suspension", async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const promise = runAdapter("signal", "default");
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(50);
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          bundle: { sourceAccounts: [], rawEvents: [{ id: "received-message" }] },
        }),
      ),
    );
    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ rawEvents: [{ id: "received-message" }] });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
