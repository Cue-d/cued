import { afterEach, describe, expect, it, vi } from "vitest";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: readFile }));

import {
  readHostSleepState,
  SleepInterruptionDetector,
  shouldDeferSyncForSleep,
} from "./system-sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  readFile.mockReset();
});

function publish(sleeping: boolean, lastWakeAt = 0) {
  readFile.mockReturnValue(JSON.stringify({ pid: process.pid, sleeping, lastWakeAt }));
}

describe("system sleep", () => {
  it("defers while sleeping and until the wake settling period ends", () => {
    vi.useFakeTimers();
    publish(true);
    expect(shouldDeferSyncForSleep()).toBe(true);
    publish(false, Date.now());
    expect(shouldDeferSyncForSleep()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(shouldDeferSyncForSleep()).toBe(false);
  });

  it("detects a missed sleep notification from a new wake and stays interrupted", () => {
    publish(false);
    const detector = new SleepInterruptionDetector();
    expect(detector.check()).toBe(false);
    publish(false, Date.now());
    expect(detector.check()).toBe(true);
    expect(detector.check()).toBe(true);
  });

  it("does not defer for an absent or dead host", () => {
    readFile.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(shouldDeferSyncForSleep()).toBe(false);
    publish(true);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(readHostSleepState()).toBeNull();
    expect(shouldDeferSyncForSleep()).toBe(false);
  });

  it("does not confuse an awake host's slow event loop with sleep", () => {
    vi.useFakeTimers();
    publish(false);
    const detector = new SleepInterruptionDetector();
    vi.setSystemTime(Date.now() + 60_000);
    expect(detector.check()).toBe(false);
  });

  it("detects suspension without a native host but allows normal watchdog ticks", () => {
    vi.useFakeTimers();
    const detector = new SleepInterruptionDetector();
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(1_000);
      expect(detector.check()).toBe(false);
    }
    vi.setSystemTime(Date.now() + 60_000);
    expect(detector.check()).toBe(true);
  });
});
