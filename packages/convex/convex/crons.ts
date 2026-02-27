/**
 * Convex scheduled functions (crons).
 *
 * Note: Cron jobs can only call queries and mutations, not actions.
 * For tasks that need to call external APIs (Vercel AI Gateway), we use
 * mutations that schedule actions via ctx.scheduler.runAfter().
 *
 * Action analysis is now event-driven (triggered from sync.ts on new messages).
 * The old scan-unanswered-conversations and process-analysis-queue crons
 * have been removed in favor of the event-driven approach.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Wake up snoozed actions that are due (every 15 minutes)
// Converts snoozed actions to pending when snoozedUntil <= now
crons.interval(
  "wake-snoozed-actions",
  { minutes: 15 },
  internal.actionEvents.wakeSnoozedActions,
);

// Mark stale devices as offline (every 30 seconds)
// This triggers reactive queries on mobile to update UI
crons.interval(
  "mark-stale-devices-offline",
  { seconds: 30 },
  internal.presence.markStaleDevicesOffline,
);

// Timeout stale queue entries (every 10 seconds)
// Handles both stuck "sending" and long-waiting "pending" with no desktop sender
crons.interval(
  "timeout-stale-sends",
  { seconds: 10 },
  internal.messageQueue.timeoutStaleSends
);

export default crons;
