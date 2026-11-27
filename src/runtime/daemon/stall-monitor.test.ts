import { describe, expect, it } from "vitest";
import { StallMonitor, type StallReport } from "./stall-monitor.js";

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy-wait: the point is to hold the event loop.
  }
}

/** Report windows in these tests are tens of ms, so a busy test runner can keep one "active". */
async function waitUntilQuiet(monitor: StallMonitor): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (monitor.isSampling && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(monitor.isSampling).toBe(false);
}

describe("stall monitor", () => {
  it("reports a blocked event loop and names the slow section", async () => {
    const reports: StallReport[] = [];
    const monitor = new StallMonitor({
      onStall: (report) => reports.push(report),
      reportIntervalMs: 50,
      stallThresholdMs: 60,
      slowSectionMs: 60,
    });
    monitor.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const returned = monitor.section("slow_query", () => {
        block(150);
        return "result";
      });
      expect(returned).toBe("result");
      monitor.section("fast_query", () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      monitor.stop();
    }

    const stalled = reports.find((report) => report.slowSections.length > 0);
    expect(stalled?.maxStallMs).toBeGreaterThanOrEqual(60);
    expect(stalled?.slowSections.map((section) => section.name)).toEqual(["slow_query"]);
  });

  it("says nothing while the loop keeps turning", async () => {
    const reports: StallReport[] = [];
    const monitor = new StallMonitor({
      onStall: (report) => reports.push(report),
      reportIntervalMs: 20,
      stallThresholdMs: 500,
    });
    monitor.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      monitor.stop();
    }
    expect(reports).toEqual([]);
  });

  it("stops sampling once the daemon goes quiet and resumes on the next request", async () => {
    const monitor = new StallMonitor({
      onStall: () => undefined,
      reportIntervalMs: 40,
      requestQuietMs: 100,
    });
    monitor.start();
    try {
      expect(monitor.isSampling).toBe(true);
      // The first report window includes start-up; a quiet one after it turns sampling off.
      await waitUntilQuiet(monitor);
      monitor.noteActivity();
      expect(monitor.isSampling).toBe(true);
      // Requests keep it on; it stops once they have stopped for the quiet period.
      await new Promise((resolve) => setTimeout(resolve, 60));
      monitor.noteActivity();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(monitor.isSampling).toBe(true);
      await waitUntilQuiet(monitor);
    } finally {
      monitor.stop();
    }
    expect(monitor.isSampling).toBe(false);
  });

  it("keeps sampling while the loop is busy even without requests", async () => {
    const monitor = new StallMonitor({ onStall: () => undefined, reportIntervalMs: 40 });
    monitor.start();
    const busy = setInterval(() => block(5), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(monitor.isSampling).toBe(true);
    } finally {
      clearInterval(busy);
      monitor.stop();
    }
  });

  it("still reports a slow section while not sampling", async () => {
    const reports: StallReport[] = [];
    const monitor = new StallMonitor({
      onStall: (report) => reports.push(report),
      reportIntervalMs: 40,
      stallThresholdMs: 100,
      slowSectionMs: 50,
    });
    monitor.start();
    try {
      await waitUntilQuiet(monitor);
      monitor.section("heartbeat", () => block(120));
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      monitor.stop();
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]?.maxStallMs).toBeGreaterThanOrEqual(120);
    expect(reports[0]?.slowSections.map((section) => section.name)).toEqual(["heartbeat"]);
  });
});
