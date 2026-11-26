import { describe, expect, it } from "vitest";
import { StallMonitor, type StallReport } from "./stall-monitor.js";

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy-wait: the point is to hold the event loop.
  }
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
});
