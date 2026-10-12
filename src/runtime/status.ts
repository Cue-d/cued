import { getCurrentAppVersion, getCurrentReleaseChannel } from "../core/app-metadata.js";
import { resolveHostOS } from "../core/platform-capabilities.js";
import type { CuedDatabase, IntegrationProjectionCount } from "../db/database.js";
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

export function buildAppStatusMetadata(db: Pick<CuedDatabase, "getAppMetadata">) {
  return {
    hostOs: resolveHostOS(),
    version: getCurrentAppVersion(),
    releaseChannel: getCurrentReleaseChannel(),
    install: db.getAppMetadata(),
  };
}

export function buildFallbackAppStatusMetadata() {
  return {
    hostOs: resolveHostOS(),
    version: getCurrentAppVersion(),
    releaseChannel: getCurrentReleaseChannel(),
    install: null,
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
    discordRealtime: DiscordRealtimeSupervisor;
    slackRealtime: SlackRealtimeSupervisor;
    linkedInRealtime: LinkedInRealtimeSupervisor;
    signalRealtime: SignalRealtimeSupervisor;
    whatsAppRealtime: WhatsAppRealtimeSupervisor;
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
    discordRealtimeSessions: options.discordRealtime.getStatuses(),
    slackRealtimeSessions: options.slackRealtime.getStatuses(),
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

export function buildMenuBarDaemonStatusSnapshot(
  db: CuedDatabase,
  options: {
    app: unknown;
    discordRealtime: DiscordRealtimeSupervisor;
    slackRealtime: SlackRealtimeSupervisor;
    linkedInRealtime: LinkedInRealtimeSupervisor;
    signalRealtime: SignalRealtimeSupervisor;
    whatsAppRealtime: WhatsAppRealtimeSupervisor;
    socketPath: string;
    bootstrap: DaemonBootstrapSnapshot;
  },
) {
  const overview = db.getMenuBarOverview();
  const projection = db.getProjectionBacklog({ initializeProjectionState: false });
  const searchIndex = db.getMessageFtsIndexBacklog();
  const phoneCalls = db.countObservedPhoneCalls();
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
    discordRealtimeSessions: options.discordRealtime.getStatuses(),
    slackRealtimeSessions: options.slackRealtime.getStatuses(),
    linkedinRealtimeSessions: options.linkedInRealtime.getStatuses(),
    signalRealtimeSessions: options.signalRealtime.getStatuses(),
    whatsappRealtimeSessions: options.whatsAppRealtime.getStatuses(),
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
