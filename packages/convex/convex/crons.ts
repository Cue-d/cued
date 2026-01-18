/**
 * Convex scheduled functions (crons).
 *
 * Note: Cron jobs can only call queries and mutations, not actions.
 * For tasks that need to call external APIs (OpenAI, Mem0), we use
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
  internal.actionEvents.wakeSnoozedActions
);

// Mark stale devices as offline (every 30 seconds)
// This triggers reactive queries on mobile to update UI
crons.interval(
  "mark-stale-devices-offline",
  { seconds: 30 },
  internal.presence.markStaleDevicesOffline
);

// Daily scan for new contacts at 9 PM UTC
// Creates eod_contact actions for unenriched contacts from today
crons.daily(
  "daily-eod-contact-scan",
  { hourUTC: 21, minuteUTC: 0 }, // 9 PM UTC (adjust for user timezone in future)
  internal.actionQueue.scanAllUsersForNewContacts
);

export default crons;
