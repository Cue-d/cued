import type { CuedDatabase, IntegrationProjectionCount } from "../db/database.js";
import type { StatusAggregates } from "../db/db-worker-jobs.js";
import {
  buildIntegrationStatus,
  listMenuBarIntegrationStates,
} from "../platforms/core/state/status.js";
import type { IntegrationStateSummary } from "../platforms/core/state/types.js";
import type { DiscordRealtimeSupervisor } from "../platforms/discord/realtime/session.js";
import type { LinkedInRealtimeSupervisor } from "../platforms/linkedin/realtime/session.js";
import type { SignalRealtimeSupervisor } from "../platforms/signal/realtime/session.js";
import type { SlackRealtimeSupervisor } from "../platforms/slack/realtime/session.js";
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

/** Realtime session statuses as plain data, so a snapshot can be built off the daemon thread. */
export interface RealtimeSessionStatuses {
  discord: ReturnType<DiscordRealtimeSupervisor["getStatuses"]>;
  slack: ReturnType<SlackRealtimeSupervisor["getStatuses"]>;
  linkedin: ReturnType<LinkedInRealtimeSupervisor["getStatuses"]>;
  signal: ReturnType<SignalRealtimeSupervisor["getStatuses"]>;
  whatsapp: ReturnType<WhatsAppRealtimeSupervisor["getStatuses"]>;
}

export function collectRealtimeSessionStatuses(supervisors: {
  discordRealtime: DiscordRealtimeSupervisor;
  slackRealtime: SlackRealtimeSupervisor;
  linkedInRealtime: LinkedInRealtimeSupervisor;
  signalRealtime: SignalRealtimeSupervisor;
  whatsAppRealtime: WhatsAppRealtimeSupervisor;
}): RealtimeSessionStatuses {
  return {
    discord: supervisors.discordRealtime.getStatuses(),
    slack: supervisors.slackRealtime.getStatuses(),
    linkedin: supervisors.linkedInRealtime.getStatuses(),
    signal: supervisors.signalRealtime.getStatuses(),
    whatsapp: supervisors.whatsAppRealtime.getStatuses(),
  };
}

export function realtimeSessionFields(realtime: RealtimeSessionStatuses) {
  return {
    discordRealtimeSessions: realtime.discord,
    slackRealtimeSessions: realtime.slack,
    linkedinRealtimeSessions: realtime.linkedin,
    signalRealtimeSessions: realtime.signal,
    whatsappRealtimeSessions: realtime.whatsapp,
  };
}

export async function buildDoctorSnapshot(
  db: CuedDatabase,
  options: {
    discordRealtime: DiscordRealtimeSupervisor;
    slackRealtime: SlackRealtimeSupervisor;
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
      slackRealtimeSessions: options.slackRealtime.getStatuses(),
      discordRealtimeSessions: options.discordRealtime.getStatuses(),
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
    realtime: RealtimeSessionStatuses;
    socketPath: string;
    bootstrap: DaemonBootstrapSnapshot;
  },
) {
  const overview = db.getOverview();
  const projection = db.getProjectionBacklog();
  const searchIndex = db.getMessageFtsIndexBacklog();
  return {
    app: options.app,
    bootstrap: options.bootstrap,
    daemon: db.getDaemonState(),
    overview,
    projection,
    dataStatus: {
      capturedRawEvents: overview.rawEvents,
      projectedMessages: overview.messages,
      pendingProjectionEvents: projection.pending_raw_events,
      pendingSearchIndexMessages: searchIndex.pending,
      failedSearchIndexMessages: searchIndex.failed,
      projectionWatermark: projection.projection_watermark,
      maxRawEventRowid: projection.max_raw_event_rowid,
    },
    checkpoints: db.listCheckpointSummary(),
    recentRuns: db.listRecentRuns(),
    ...realtimeSessionFields(options.realtime),
    whatsappDiagnostics: buildWhatsAppDiagnostics(db, options.realtime.whatsapp),
    ...buildIntegrationStatus(db, {
      includeLiveLocalIntegrations: false,
    }),
    update: getUpdateStatus(db),
    socketPath: options.socketPath,
    dbPath: db.dbPath,
  };
}

export function buildMenuBarDaemonStatusSnapshot(
  db: CuedDatabase,
  options: {
    app: unknown;
    realtime: RealtimeSessionStatuses;
    socketPath: string;
    bootstrap: DaemonBootstrapSnapshot;
    /**
     * Row counts computed ahead of time. Counting scans large tables, so the daemon counts on
     * its database worker and passes the result in; without it the counts run on this thread.
     */
    aggregates?: StatusAggregates;
  },
) {
  const overview = options.aggregates?.overview ?? db.getMenuBarOverview();
  const projection = db.getProjectionBacklog({ initializeProjectionState: false });
  const searchIndex = options.aggregates?.searchIndex ?? db.getMessageFtsIndexBacklog();
  const phoneCalls = options.aggregates?.phoneCalls ?? db.countObservedPhoneCalls();
  const integrations = hydrateIntegrationProjectionCounts(
    listMenuBarIntegrationStates(db),
    overview.integrationBreakdown,
  );
  return {
    app: options.app,
    bootstrap: options.bootstrap,
    daemon: db.getDaemonState(),
    overview,
    projection,
    dataStatus: {
      capturedRawEvents: overview.rawEvents,
      projectedMessages: overview.messages,
      pendingProjectionEvents: projection.pending_raw_events,
      pendingSearchIndexMessages: searchIndex.pending,
      failedSearchIndexMessages: searchIndex.failed,
      projectionWatermark: projection.projection_watermark,
      maxRawEventRowid: projection.max_raw_event_rowid,
    },
    relationshipSummary: {
      messages: overview.messages,
      contacts: overview.contacts,
      phoneCalls,
      pendingProjectionEvents: projection.pending_raw_events,
      lastUpdatedAt: Date.now(),
      source: "menu_bar_cache",
    },
    integrations,
    ...realtimeSessionFields(options.realtime),
    update: getUpdateStatus(db),
    socketPath: options.socketPath,
    dbPath: db.dbPath,
  };
}

export function hydrateIntegrationProjectionCounts(
  integrations: IntegrationStateSummary[],
  counts: IntegrationProjectionCount[],
): IntegrationStateSummary[] {
  const countsByIntegration = new Map(
    counts.map((row) => [`${row.platform}\u0000${row.accountKey}`, row]),
  );
  return integrations.map((integration) => {
    const projectionCounts = countsByIntegration.get(
      `${integration.platform}\u0000${integration.accountKey}`,
    );
    return {
      ...integration,
      projectionStats: {
        ...integration.projectionStats,
        projectedContacts: projectionCounts?.contacts ?? 0,
        projectedMessages: projectionCounts?.messages ?? 0,
      },
    };
  });
}
