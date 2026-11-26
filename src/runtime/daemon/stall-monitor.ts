import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const DEFAULT_REPORT_INTERVAL_MS = 10_000;
const DEFAULT_STALL_THRESHOLD_MS = 100;
const DEFAULT_SLOW_SECTION_MS = 50;

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
 */
export class StallMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private readonly slowSections: Array<{ name: string; durationMs: number }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      onStall: (report: StallReport) => void;
      reportIntervalMs?: number;
      stallThresholdMs?: number;
      slowSectionMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.histogram.enable();
    this.timer = setInterval(
      () => this.report(),
      this.options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram.disable();
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

  private report(): void {
    const maxStallMs = this.histogram.max / 1e6;
    const p99StallMs = this.histogram.percentile(99) / 1e6;
    this.histogram.reset();
    const slowSections = this.slowSections
      .splice(0)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5);
    if (maxStallMs >= (this.options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS)) {
      this.options.onStall({
        maxStallMs: Math.round(maxStallMs),
        p99StallMs: Math.round(p99StallMs),
        slowSections,
      });
    }
  }
}
