import type { CuedDatabase } from "../db/database.js";
import { buildIntegrationStatus } from "../platforms/core/state/status.js";
import type { LinkedInRealtimeSupervisor } from "../platforms/linkedin/realtime/session.js";
import type { SignalRealtimeSupervisor } from "../platforms/signal/realtime/session.js";
import { buildWhatsAppDiagnostics } from "../platforms/whatsapp/diagnostics.js";
import type { WhatsAppRealtimeSupervisor } from "../platforms/whatsapp/realtime/session.js";
import { buildDoctorReport } from "./doctor.js";
import { doctorHooksConfig } from "./hooks.js";
import { getUpdateStatus } from "./updater/service.js";

export interface DaemonBootstrapSnapshot {
  state: "starting" | "ready" | "failed";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export async function buildDoctorSnapshot(
  db: CuedDatabase,
  options: {
    linkedInRealtime: LinkedInRealtimeSupervisor;
    signalRealtime: SignalRealtimeSupervisor;
    whatsAppRealtime: WhatsAppRealtimeSupervisor;
    autoSyncTargets: Array<{ platform: string; accountKey: string }>;
    autoSyncIntervalMs: number;
    autoSyncIntervalsMs: Record<string, number>;
    signalCatchupIntervalMs: number;
    whatsappCatchupIntervalMs: number;
    ingestConcurrency: number;
    projectionBatchSize: number;
    realtimeProjectionEnabled: boolean;
    realtimeProjectionBatchSize: number;
    deferredProjectionCoalesceMs: number;
    app: unknown;
    bootstrap: DaemonBootstrapSnapshot;
  },
) {
  return {
    app: options.app,
    bootstrap: options.bootstrap,
    ...(await buildDoctorReport(db, {
      linkedinRealtimeSessions: options.linkedInRealtime.getStatuses(),
      signalRealtimeSessions: options.signalRealtime.getStatuses(),
      whatsappRealtimeSessions: options.whatsAppRealtime.getStatuses(),
    })),
    autoSyncTargets: options.autoSyncTargets,
    autoSyncIntervalMs: options.autoSyncIntervalMs,
    autoSyncIntervalsMs: options.autoSyncIntervalsMs,
    signalCatchupIntervalMs: options.signalCatchupIntervalMs,
    whatsappCatchupIntervalMs: options.whatsappCatchupIntervalMs,
    ingestConcurrency: options.ingestConcurrency,
    projectionBatchSize: options.projectionBatchSize,
    realtimeProjectionEnabled: options.realtimeProjectionEnabled,
    realtimeProjectionBatchSize: options.realtimeProjectionBatchSize,
    deferredProjectionCoalesceMs: options.deferredProjectionCoalesceMs,
    hooks: doctorHooksConfig(),
    update: getUpdateStatus(db),
  };
}

export function buildDaemonStatusSnapshot(
  db: CuedDatabase,
  options: {
    app: unknown;
    linkedInRealtime: LinkedInRealtimeSupervisor;
    signalRealtime: SignalRealtimeSupervisor;
    whatsAppRealtime: WhatsAppRealtimeSupervisor;
    socketPath: string;
    bootstrap: DaemonBootstrapSnapshot;
  },
) {
  return {
    app: options.app,
    bootstrap: options.bootstrap,
    daemon: db.getDaemonState(),
    overview: db.getOverview(),
    projection: db.getProjectionBacklog(),
    checkpoints: db.listCheckpointSummary(),
    recentRuns: db.listRecentRuns(),
    linkedinRealtimeSessions: options.linkedInRealtime.getStatuses(),
    signalRealtimeSessions: options.signalRealtime.getStatuses(),
    whatsappRealtimeSessions: options.whatsAppRealtime.getStatuses(),
    whatsappDiagnostics: buildWhatsAppDiagnostics(db, options.whatsAppRealtime.getStatuses()),
    ...buildIntegrationStatus(db, {
      includeLiveLocalIntegrations: false,
    }),
    update: getUpdateStatus(db),
    socketPath: options.socketPath,
    dbPath: db.dbPath,
  };
}
