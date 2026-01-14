/**
 * Convex scheduled functions (crons).
 *
 * Note: Cron jobs can only call queries and mutations, not actions.
 * For memory processing which requires calling external APIs (Mem0),
 * we use an HTTP endpoint that can be called from:
 * 1. Manual trigger via POST /api/memories/process
 * 2. External scheduler (Vercel cron, etc.) calling the endpoint
 *
 * This file is kept as a placeholder for future internal scheduled tasks.
 */
import { cronJobs } from "convex/server";

const crons = cronJobs();

// Future cron jobs can be added here for internal tasks
// Example:
// crons.interval("cleanup-expired-actions", { hours: 24 }, internal.actions.cleanupExpired);

export default crons;
