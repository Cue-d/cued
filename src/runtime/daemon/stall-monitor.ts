import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const DEFAULT_REPORT_INTERVAL_MS = 10_000;
const DEFAULT_STALL_THRESHOLD_MS = 100;
const DEFAULT_SLOW_SECTION_MS = 50;
const HISTOGRAM_RESOLUTION_MS = 10;
// A window in which the loop was busy at least this share of the time counts as active, even
// if nothing called noteActivity(): realtime sessions, child-process output and the like.
const ACTIVE_UTILIZATION = 0.01;
// After the last request, sampling continues this long. Requests are timed as sections anyway;
// sampling around them catches other work that held them up.
const DEFAULT_REQUEST_QUIET_MS = 1_000;

export type StallReport = {
  maxStallMs: number;
  p99StallMs: number;
  /** The slowest named sections in the window: what the daemon was doing when it stalled. */
  slowSections: Array<{ name: string; durationMs: number }>;
};

/**
 * Notices when the daemon's event loop stops turning, and names what was running.
 *
 * Everything the daemon does synchronously (SQLite, spawning a helper) blocks every request
 * behind it, and from the outside that is just "the app is slow". This samples event-loop
 * delay and, once per interval, reports the worst stall together with the slowest sections
 * that callers wrapped in `section()`, so a stall in the field comes with a cause.
 *
 * Sampling is a timer every 10 ms, which on its own is most of what an idle daemon costs, so
 * it only runs while the daemon is active: for a second after each request (`noteActivity()`),
 * and through any report interval that follows one in which the loop was measurably busy. At
 * rest a stall can still only come from work on the loop: named sections are timed regardless,
 * and the report timer notices when it fires late.
 */
export class StallMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  private readonly slowSections: Array<{ name: string; durationMs: number }> = [];
  private timer: NodeJS.Timeout | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private sampling = false;
  /** The last report interval was busy: keep sampling through the next one. */
  private busy = false;
  private lastActivityAt = 0;
  private reportDueAt = 0;
  private utilization: ReturnType<typeof performance.eventLoopUtilization> | null = null;

  constructor(
    private readonly options: {
      onStall: (report: StallReport) => void;
      reportIntervalMs?: number;
      stallThresholdMs?: number;
      slowSectionMs?: number;
      requestQuietMs?: number;
    },
  ) {}

  /** Whether the 10 ms delay sampler is running right now. */
  get isSampling(): boolean {
    return this.sampling;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    // Start-up is busy; sample until the first report says otherwise.
    this.busy = true;
    this.startSampling();
    this.utilization = performance.eventLoopUtilization();
    this.scheduleReport();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearQuietTimer();
    this.stopSampling();
  }

  /** Something the daemon must answer promptly arrived: sample delay until things go quiet. */
  noteActivity(): void {
    if (!this.timer) {
      return;
    }
    this.lastActivityAt = performance.now();
    if (!this.sampling) {
      this.startSampling();
    }
    if (!this.quietTimer) {
      this.scheduleQuietCheck(this.requestQuietMs);
    }
  }

  /** Runs synchronous work, remembering it if it ran long enough to be felt. */
  section<T>(name: string, run: () => T): T {
    const startedAt = performance.now();
    try {
      return run();
    } finally {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= (this.options.slowSectionMs ?? DEFAULT_SLOW_SECTION_MS)) {
        this.slowSections.push({ name, durationMs: Math.round(durationMs) });
      }
    }
  }

  private get reportIntervalMs(): number {
    return this.options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
  }

  private get requestQuietMs(): number {
    return this.options.requestQuietMs ?? DEFAULT_REQUEST_QUIET_MS;
  }

  private scheduleQuietCheck(delayMs: number): void {
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      const sinceActivityMs = performance.now() - this.lastActivityAt;
      if (sinceActivityMs < this.requestQuietMs) {
        this.scheduleQuietCheck(this.requestQuietMs - sinceActivityMs);
      } else if (!this.busy && this.sampling) {
        this.stopSampling();
      }
    }, delayMs);
    this.quietTimer.unref?.();
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  private startSampling(): void {
    this.histogram.reset();
    this.histogram.enable();
    this.sampling = true;
  }

  private stopSampling(): void {
    this.histogram.disable();
    this.histogram.reset();
    this.sampling = false;
  }

  private scheduleReport(): void {
    this.reportDueAt = performance.now() + this.reportIntervalMs;
    this.timer = setTimeout(() => this.report(), this.reportIntervalMs);
    this.timer.unref?.();
  }

  private report(): void {
    // How late this timer fired is itself a stall measurement, and the only one while the
    // sampler is off.
    const lateMs = Math.max(0, performance.now() - this.reportDueAt);
    const sampled = this.sampling && this.histogram.count > 0;
    const sampledMaxMs = sampled ? this.histogram.max / 1e6 : 0;
    const p99StallMs = sampled ? this.histogram.percentile(99) / 1e6 : 0;
    if (this.sampling) {
      this.histogram.reset();
    }
    const slowSections = this.slowSections
      .splice(0)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5);
    // A synchronous section held the loop for as long as it ran.
    const slowestSectionMs = slowSections[0]?.durationMs ?? 0;
    const maxStallMs = Math.max(sampledMaxMs, lateMs, slowestSectionMs);
    if (maxStallMs >= (this.options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS)) {
      this.options.onStall({
        maxStallMs: Math.round(maxStallMs),
        p99StallMs: Math.round(p99StallMs),
        slowSections,
      });
    }

    const window = performance.eventLoopUtilization(this.utilization ?? undefined);
    this.utilization = performance.eventLoopUtilization();
    this.busy = window.utilization >= ACTIVE_UTILIZATION;
    const recentRequest = performance.now() - this.lastActivityAt < this.requestQuietMs;
    if (this.busy || recentRequest) {
      if (!this.sampling) {
        this.startSampling();
      }
    } else if (this.sampling) {
      this.stopSampling();
    }
    this.scheduleReport();
  }
}
