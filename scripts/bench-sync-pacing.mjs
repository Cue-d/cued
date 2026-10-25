// Deterministic one-hour scheduling workload; no provider calls or credentials.
// Build first, then: node scripts/bench-sync-pacing.mjs
import { AutoSyncPacing } from "../dist/runtime/daemon/sync-pacing.js";

const durationMs = 60 * 60_000;
const baseMs = 60_000;
function quietSchedule(adaptive, realtime) {
  const pacing = new AutoSyncPacing();
  let lastQueuedAt = 0;
  let requests = 0;
  for (let now = 1000; now <= durationMs; now += 1000) {
    const interval = adaptive ? pacing.interval("account", baseMs, realtime) : baseMs;
    if (now - lastQueuedAt < interval) continue;
    requests++;
    lastQueuedAt = now;
    pacing.record("account", 0, false);
  }
  return requests;
}
console.log(
  JSON.stringify(
    {
      workload:
        "One quiet account, one-hour horizon, one-second scheduler ticks, successful empty runs",
      pullOnly: { before: quietSchedule(false, false), after: quietSchedule(true, false) },
      realtimeCovered: { before: quietSchedule(false, true), after: quietSchedule(true, true) },
    },
    null,
    2,
  ),
);
