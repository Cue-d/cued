import { describe, expect, it } from "vitest";
import {
  AUTO_SYNC_PACING,
  AutoSyncPacing,
  autoSyncPushPath,
  historyContinuationDelayMs,
  isScheduledSyncDue,
  type PowerState,
  type PushPathState,
  SchedulerWakeDetector,
} from "./sync-pacing.js";

const MINUTE = 60_000;
const TICK_MS = 15_000;
const AC: PowerState = { onBattery: false, lowPowerMode: false };
const BATTERY: PowerState = { onBattery: true, lowPowerMode: false };

/**
 * Drives the scheduler's decision on a fake clock: a tick every 15 s, every due run finishes
 * at once and inserts nothing. Returns how many runs it queued and the longest gap between
 * two of them (the worst-case wait for something only a poll would find).
 */
function simulateIdle(input: {
  baseMs: number;
  push: PushPathState | ((nowMs: number) => PushPathState);
  power?: PowerState | null;
  durationMs?: number;
  pacing?: AutoSyncPacing;
  onTick?: (nowMs: number, pacing: AutoSyncPacing) => void;
}): { runs: number; longestGapMs: number; runTimes: number[] } {
  const pacing = input.pacing ?? new AutoSyncPacing();
  const durationMs = input.durationMs ?? 60 * MINUTE;
  let lastQueuedAt = 0;
  const runTimes: number[] = [];
  for (let nowMs = TICK_MS; nowMs <= durationMs; nowMs += TICK_MS) {
    input.onTick?.(nowMs, pacing);
    const push = typeof input.push === "function" ? input.push(nowMs) : input.push;
    const intervalMs = pacing.interval("p:a", {
      baseMs: input.baseMs,
      push,
      power: input.power ?? AC,
    });
    if (!isScheduledSyncDue({ nowMs, lastQueuedAt, intervalMs })) continue;
    lastQueuedAt = nowMs;
    runTimes.push(nowMs);
    pacing.record("p:a", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
  }
  let longestGapMs = 0;
  let previous = 0;
  for (const at of runTimes) {
    longestGapMs = Math.max(longestGapMs, at - previous);
    previous = at;
  }
  return { runs: runTimes.length, longestGapMs, runTimes };
}

describe("idle back-off for poll-only sources", () => {
  it("doubles after each quiet run up to 4x on AC power", () => {
    const pacing = new AutoSyncPacing();
    const interval = () => pacing.interval("gmail:a", { baseMs: MINUTE, push: "none", power: AC });
    expect(interval()).toBe(MINUTE);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      pacing.record("gmail:a", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
      seen.push(interval());
    }
    expect(seen).toEqual([2, 4, 4, 4, 4, 4].map((n) => n * MINUTE));
  });

  it("settles at 15 runs an hour instead of 30, at most 4 minutes apart", () => {
    const { runs, longestGapMs } = simulateIdle({ baseMs: MINUTE, push: "none" });
    expect(runs).toBe(16);
    expect(longestGapMs).toBe(4 * MINUTE);
  });

  it("resets on new events, on more pages and on a run someone asked for", () => {
    const pacing = new AutoSyncPacing();
    const quiet = () =>
      pacing.record("gmail:a", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
    const interval = () => pacing.interval("gmail:a", { baseMs: MINUTE, push: "none", power: AC });
    for (const activity of [
      { insertedEvents: 3, hasMore: false, trigger: "scheduler" },
      { insertedEvents: 0, hasMore: true, trigger: "scheduler" },
      { insertedEvents: 0, hasMore: false, trigger: "cli" },
      { insertedEvents: 0, hasMore: false, trigger: "integration_authenticated" },
    ]) {
      quiet();
      quiet();
      expect(interval()).toBe(4 * MINUTE);
      pacing.record("gmail:a", activity);
      expect(interval()).toBe(MINUTE);
    }
    quiet();
    quiet();
    pacing.reset("gmail:a");
    expect(interval()).toBe(MINUTE);
  });

  it("returns to the normal interval within one tick after the app opens or the machine wakes", () => {
    const { runTimes } = simulateIdle({
      baseMs: MINUTE,
      push: "none",
      durationMs: 30 * MINUTE,
      onTick: (nowMs, pacing) => {
        if (nowMs === 20 * MINUTE + TICK_MS) pacing.resetAll();
      },
    });
    // Backed off to 4 min (…, 15:00, 19:00), reset at 20:15, so a run is due at once (over a
    // minute since the last) and the back-off starts over: 22:15, 26:15.
    expect(runTimes.filter((at) => at > 19 * MINUTE)).toEqual([
      20 * MINUTE + TICK_MS,
      22 * MINUTE + TICK_MS,
      26 * MINUTE + TICK_MS,
    ]);
  });
});

describe("push paths drive", () => {
  it("polls a healthy watcher or session only as a 30-minute safety net", () => {
    expect(simulateIdle({ baseMs: MINUTE, push: "healthy" })).toMatchObject({
      runs: 2,
      longestGapMs: 30 * MINUTE,
    });
    // A 5-minute platform keeps its 40-minute ceiling (8 x 5 min).
    const whatsapp = simulateIdle({
      baseMs: 5 * MINUTE,
      push: "healthy",
      durationMs: 120 * MINUTE,
    });
    expect(whatsapp.longestGapMs).toBe(40 * MINUTE);
    expect(whatsapp.runs).toBe(3);
  });

  it("ignores realtime event chatter while the push path is healthy", () => {
    const pacing = new AutoSyncPacing();
    pacing.reset("whatsapp:a");
    expect(pacing.interval("whatsapp:a", { baseMs: 5 * MINUTE, push: "healthy" })).toBe(
      40 * MINUTE,
    );
  });

  it("polls at the normal interval after a safety-net run found something the push path missed", () => {
    const pacing = new AutoSyncPacing();
    pacing.record("imessage:local", { insertedEvents: 2, hasMore: false, trigger: "scheduler" });
    expect(pacing.interval("imessage:local", { baseMs: MINUTE, push: "healthy" })).toBe(MINUTE);
    pacing.record("imessage:local", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
    expect(pacing.interval("imessage:local", { baseMs: MINUTE, push: "healthy" })).toBe(
      30 * MINUTE,
    );
  });

  it("catches up once after a wake even while the push path is healthy", () => {
    const pacing = new AutoSyncPacing();
    pacing.record("imessage:local", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
    pacing.resetAll();
    expect(pacing.interval("imessage:local", { baseMs: MINUTE, push: "healthy" })).toBe(MINUTE);
    pacing.record("imessage:local", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
    expect(pacing.interval("imessage:local", { baseMs: MINUTE, push: "healthy" })).toBe(
      30 * MINUTE,
    );
  });

  it("falls back to normal polling within a tick when the watcher goes down", () => {
    const watcherDiesAt = 40 * MINUTE;
    const { runTimes } = simulateIdle({
      baseMs: MINUTE,
      push: (nowMs) => (nowMs < watcherDiesAt ? "healthy" : "down"),
    });
    // Safety net at 30:00, watcher down at 40:00: due at once (10 min since the last run),
    // then at most 2 minutes apart, as before this change.
    expect(runTimes.slice(0, 3)).toEqual([30 * MINUTE, 40 * MINUTE, 42 * MINUTE]);
    const after = runTimes.filter((at) => at >= 40 * MINUTE);
    for (let i = 1; i < after.length; i++) {
      expect(after[i] - after[i - 1]).toBeLessThanOrEqual(2 * MINUTE);
    }
  });

  it("classifies each platform's push path", () => {
    const watchers = (running: string[]) => ({
      watcherRunning: (name: string) => running.includes(name),
      realtimeConnected: false,
    });
    expect(autoSyncPushPath("imessage", watchers(["imessage", "callhistory"]))).toBe("healthy");
    // Either watcher being down leaves part of the account uncovered.
    expect(autoSyncPushPath("imessage", watchers(["imessage"]))).toBe("down");
    expect(autoSyncPushPath("imessage", watchers(["callhistory"]))).toBe("down");
    expect(autoSyncPushPath("imessage", watchers([]))).toBe("down");
    expect(autoSyncPushPath("contacts", watchers(["contacts"]))).toBe("healthy");
    expect(autoSyncPushPath("contacts", watchers([]))).toBe("down");
    for (const platform of ["whatsapp", "signal", "linkedin", "discord"]) {
      expect(autoSyncPushPath(platform, { ...watchers([]), realtimeConnected: true })).toBe(
        "healthy",
      );
      expect(autoSyncPushPath(platform, watchers([]))).toBe("down");
    }
    expect(autoSyncPushPath("slack", { ...watchers([]), realtimeConnected: true })).toBe("none");
    expect(autoSyncPushPath("slack", watchers([]))).toBe("down");
    expect(autoSyncPushPath("gmail", watchers([]))).toBe("none");
  });
});

describe("battery", () => {
  it("doubles the poll-only cap and the safety net on battery or in Low Power Mode", () => {
    for (const power of [BATTERY, { onBattery: false, lowPowerMode: true }]) {
      expect(simulateIdle({ baseMs: MINUTE, push: "none", power }).longestGapMs).toBe(8 * MINUTE);
      expect(
        simulateIdle({ baseMs: MINUTE, push: "healthy", power, durationMs: 180 * MINUTE })
          .longestGapMs,
      ).toBe(60 * MINUTE);
      // With the push path down, polling is the only path: it does not slow down.
      expect(simulateIdle({ baseMs: MINUTE, push: "down", power }).longestGapMs).toBe(2 * MINUTE);
    }
  });

  it("behaves as before on AC power or with unknown power", () => {
    for (const power of [AC, null]) {
      expect(simulateIdle({ baseMs: MINUTE, push: "down", power }).longestGapMs).toBe(2 * MINUTE);
    }
  });

  it("slows automatic history pages that realtime covers, and nothing else", () => {
    const history = {
      baseMs: 15_000,
      originTrigger: "scheduler",
      syncMode: "full",
      liveCoverage: true,
      continuationReason: "account_pagination",
      power: BATTERY,
    };
    expect(historyContinuationDelayMs(history)).toBe(AUTO_SYNC_PACING.onBatteryHistoryContinueMs);
    expect(
      historyContinuationDelayMs({ ...history, power: { onBattery: false, lowPowerMode: true } }),
    ).toBe(60_000);
    expect(historyContinuationDelayMs({ ...history, baseMs: 120_000 })).toBe(120_000);
    for (const override of [
      { syncMode: "incremental" },
      { originTrigger: "cli" },
      { originTrigger: "integration_authenticated" },
      { liveCoverage: false },
      { power: null },
      { power: AC },
      { continuationReason: "realtime_catchup" },
      { continuationReason: "rate_limit_backoff" },
    ]) {
      expect(historyContinuationDelayMs({ ...history, ...override })).toBe(15_000);
    }
  });
});

describe("app opened", () => {
  it("resets the back-off at most once every 5 minutes, however often the app asks", () => {
    const pacing = new AutoSyncPacing();
    const quiet = () =>
      pacing.record("gmail:a", { insertedEvents: 0, hasMore: false, trigger: "scheduler" });
    const interval = () => pacing.interval("gmail:a", { baseMs: MINUTE, push: "none" });
    quiet();
    quiet();
    pacing.noteAppOpened(0);
    expect(interval()).toBe(MINUTE);
    quiet();
    quiet();
    pacing.noteAppOpened(MINUTE);
    expect(interval()).toBe(4 * MINUTE);
    pacing.noteAppOpened(5 * MINUTE);
    expect(interval()).toBe(MINUTE);
  });
});

describe("wake detection", () => {
  it("sees a wake from the host's wake time or from a late tick", () => {
    const detector = new SchedulerWakeDetector(TICK_MS);
    expect(detector.check(0, 100)).toBe(false);
    expect(detector.check(TICK_MS, 100)).toBe(false);
    expect(detector.check(2 * TICK_MS, 200)).toBe(true);
    expect(detector.check(3 * TICK_MS, 200)).toBe(false);
    // No host: a tick that fires a minute late means the machine was suspended.
    const standalone = new SchedulerWakeDetector(TICK_MS);
    standalone.check(0, null);
    expect(standalone.check(TICK_MS, null)).toBe(false);
    expect(standalone.check(TICK_MS + 61_000, null)).toBe(true);
  });
});
