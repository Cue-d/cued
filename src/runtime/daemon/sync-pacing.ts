/**
 * How often the auto-sync scheduler polls an account, and how fast history pages continue.
 *
 * Every scheduled run starts an adapter (a worker thread or a helper process) and reads a
 * source, and while nothing changes it inserts nothing. So the scheduler polls as little as
 * the account's other paths allow:
 *
 * - push, healthy: a native file watcher or a connected realtime session already delivers new
 *   messages within seconds, so polling is only a safety net for something the push path
 *   dropped without noticing.
 * - push, down: the account has a push path but it is not running. Poll at the platform's
 *   normal interval, backing off only a little.
 * - poll only: polling is the only way new messages arrive. Back off after quiet runs, and
 *   return to the normal interval as soon as anything happens.
 *
 * On battery or in Low Power Mode the poll-only cap and the safety net widen. The push-down
 * fallback does not: there polling is how new messages arrive until the push path is back.
 * On AC power, and when the power source is unknown, nothing widens.
 */

export type PushPathState = "healthy" | "down" | "none";

export interface PowerState {
  onBattery: boolean;
  lowPowerMode: boolean;
}

export const AUTO_SYNC_PACING = {
  /** Least time between safety-net polls of an account whose push path is healthy. */
  safetyNetMs: 30 * 60_000,
  /** The safety net is never shorter than this many normal intervals (5 min → 40 min). */
  safetyNetBaseMultiple: 8,
  /** Most an interval grows after quiet runs, as a multiple of the normal interval. */
  pollOnlyCap: 4,
  pushDownCap: 2,
  /** The poll-only cap and the safety net are multiplied by this on battery or Low Power Mode. */
  onBatteryFactor: 2,
  /** The app asks for a fresh snapshot on open and during permission prompts: reset once. */
  appOpenedResetMinMs: 5 * 60_000,
  /** On battery, automatic history pages wait at least this long between them. */
  onBatteryHistoryContinueMs: 60_000,
} as const;

export function isOnReducedPower(power: PowerState | null | undefined): boolean {
  return power?.onBattery === true || power?.lowPowerMode === true;
}

/** Triggers that come from the scheduler itself; any other run is someone asking for it. */
const SCHEDULED_TRIGGERS = new Set(["scheduler", "ingest_continue"]);

interface PacingState {
  quietRuns: number;
  /** The last scheduled run found something a healthy push path had not delivered. */
  foundMissed: boolean;
  /** The catch-up generation this account last ran in. */
  generation: number;
}

export class AutoSyncPacing {
  private states = new Map<string, PacingState>();
  /** Raised by resetAll: every account, push paths included, runs once at its normal interval. */
  private generation = 0;
  private lastAppOpenedAt: number | null = null;

  /** Records what a finished run found. */
  record(
    key: string,
    run: { insertedEvents: number; hasMore: boolean; trigger?: string | null },
  ): void {
    const generation = this.generation;
    if (run.insertedEvents > 0 || run.hasMore) {
      this.states.set(key, { quietRuns: 0, foundMissed: true, generation });
      return;
    }
    if (run.trigger != null && !SCHEDULED_TRIGGERS.has(run.trigger)) {
      // Someone asked for this run (a manual sync, a watcher, a reconnect): start counting
      // quiet runs again rather than holding on to an earlier back-off.
      this.states.set(key, { quietRuns: 0, foundMissed: false, generation });
      return;
    }
    const quietRuns = Math.min(16, (this.states.get(key)?.quietRuns ?? 0) + 1);
    this.states.set(key, { quietRuns, foundMissed: false, generation });
  }

  /** Something happened on the account (an event, a failure): poll at the normal interval. */
  reset(key: string): void {
    const state = this.states.get(key);
    if (state) {
      state.quietRuns = 0;
    }
  }

  /**
   * The user is looking (app opened) or the machine just woke: every account polls once at its
   * normal interval, push paths included (a watcher or session may have missed what arrived
   * while the machine slept), and poll-only accounts start their back-off again.
   */
  resetAll(): void {
    this.generation += 1;
    for (const state of this.states.values()) {
      state.quietRuns = 0;
    }
  }

  /** The app opened. Resets at most once per `appOpenedResetMinMs`, however often it asks. */
  noteAppOpened(nowMs: number): void {
    if (
      this.lastAppOpenedAt != null &&
      nowMs - this.lastAppOpenedAt < AUTO_SYNC_PACING.appOpenedResetMinMs
    ) {
      return;
    }
    this.lastAppOpenedAt = nowMs;
    this.resetAll();
  }

  quietRuns(key: string): number {
    return this.states.get(key)?.quietRuns ?? 0;
  }

  interval(
    key: string,
    input: { baseMs: number; push: PushPathState; power?: PowerState | null },
  ): number {
    const state = this.states.get(key);
    const factor = isOnReducedPower(input.power) ? AUTO_SYNC_PACING.onBatteryFactor : 1;
    const caughtUp = this.generation === 0 || state?.generation === this.generation;
    if (input.push === "healthy" && caughtUp && !state?.foundMissed) {
      return (
        Math.max(
          AUTO_SYNC_PACING.safetyNetMs,
          input.baseMs * AUTO_SYNC_PACING.safetyNetBaseMultiple,
        ) * factor
      );
    }
    const cap =
      input.push === "none" ? AUTO_SYNC_PACING.pollOnlyCap * factor : AUTO_SYNC_PACING.pushDownCap;
    return input.baseMs * Math.min(cap, 2 ** (state?.quietRuns ?? 0));
  }
}

/** Whether the scheduler queues a run for an account on this tick. */
export function isScheduledSyncDue(input: {
  nowMs: number;
  lastQueuedAt: number;
  intervalMs: number;
}): boolean {
  return input.nowMs - input.lastQueuedAt >= input.intervalMs;
}

/**
 * Detects a wake from sleep from the scheduler's own ticks: a timer that fires much later than
 * it was due means the machine was suspended. The host's published wake time is preferred
 * when it is there; this covers a standalone daemon.
 */
export class SchedulerWakeDetector {
  private lastTickAt: number | null = null;
  private lastHostWakeAt: number | null = null;

  constructor(private readonly tickMs: number) {}

  check(nowMs: number, hostLastWakeAt: number | null | undefined): boolean {
    const previousTickAt = this.lastTickAt;
    const previousHostWakeAt = this.lastHostWakeAt;
    this.lastTickAt = nowMs;
    this.lastHostWakeAt = hostLastWakeAt ?? previousHostWakeAt;
    if (previousTickAt == null) {
      return false;
    }
    if (
      hostLastWakeAt != null &&
      previousHostWakeAt != null &&
      hostLastWakeAt > previousHostWakeAt
    ) {
      return true;
    }
    return nowMs - previousTickAt > this.tickMs * 2 + 30_000;
  }
}

/**
 * Delay before the next page of a sync that has more to read. On battery or in Low Power
 * Mode, automatic full-history pages wait at least a minute, but only while a connected
 * realtime session delivers new messages on its own: elsewhere a queued history page also
 * holds back the next catch-up, so slowing it would make new messages arrive later. Manual
 * and reconnect syncs, incremental catch-up and provider back-off keep their own delay.
 */
export function historyContinuationDelayMs(input: {
  baseMs: number;
  originTrigger: string;
  syncMode: string;
  liveCoverage: boolean;
  continuationReason: string | null | undefined;
  power: PowerState | null;
}): number {
  const automatic = input.originTrigger === "scheduler" || input.originTrigger === "daemon_start";
  const historical =
    input.syncMode === "full" &&
    (input.continuationReason === "account_pagination" ||
      input.continuationReason === "scoped_proof_continuation");
  return automatic && historical && input.liveCoverage && isOnReducedPower(input.power)
    ? Math.max(input.baseMs, AUTO_SYNC_PACING.onBatteryHistoryContinueMs)
    : input.baseMs;
}

/**
 * Which push path covers new messages for an account. Slack's realtime session covers new
 * messages but not replies in older threads, which only a scheduled sync finds; so with the
 * session up Slack still polls as a poll-only source, and polls normally when it is down.
 */
export function autoSyncPushPath(
  platform: string,
  input: {
    watcherRunning: (watcher: "contacts" | "imessage" | "callhistory") => boolean;
    realtimeConnected: boolean;
  },
): PushPathState {
  switch (platform) {
    case "contacts":
      return input.watcherRunning("contacts") ? "healthy" : "down";
    case "imessage":
      // The Messages and call-history watchers observe the databases' directories, so they
      // fire when a file is created, renamed or removed there. A message appended to the
      // existing database or its write-ahead log raises nothing. They speed some syncs up
      // but cannot stand in for polling, so iMessage polls as it always has.
      return "down";
    case "whatsapp":
    case "signal":
    case "linkedin":
    case "discord":
      return input.realtimeConnected ? "healthy" : "down";
    case "slack":
      return input.realtimeConnected ? "none" : "down";
    default:
      return "none";
  }
}
