import { afterEach, beforeEach, vi } from "vitest";
import type { convexTest } from "convex-test";

export function useSchedulerCleanup() {
  const scheduledTests: Array<ReturnType<typeof convexTest>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const t of scheduledTests) {
      await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());
    }
    scheduledTests.length = 0;
    vi.useRealTimers();
  });

  return {
    trackTest: (t: ReturnType<typeof convexTest>) => {
      scheduledTests.push(t);
      return t;
    },
  };
}
