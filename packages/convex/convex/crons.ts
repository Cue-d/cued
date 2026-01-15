/**
 * Convex scheduled functions (crons).
 *
 * Note: Cron jobs can only call queries and mutations, not actions.
 * For tasks that need to call external APIs (OpenAI, Mem0), we use
 * mutations that schedule actions via ctx.scheduler.runAfter().
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Task 7.5: Scan for unanswered conversations every 5 minutes
// Finds conversations needing action and queues them for LLM analysis
crons.interval(
  "scan-unanswered-conversations",
  { minutes: 5 },
  internal.actionQueue.scanAllUsersForUnanswered
);

// Task 7.7: Process analysis queue every 30 seconds
// Picks next pending entry and schedules LLM analysis
crons.interval(
  "process-analysis-queue",
  { seconds: 30 },
  internal.actionQueue.triggerQueueProcessing
);

export default crons;
