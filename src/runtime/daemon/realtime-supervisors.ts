import { createLogger } from "../../core/logging.js";
import type { AdapterPlatform } from "../../core/types/provider.js";
import type { CuedDatabase } from "../../db/database.js";
import { DiscordRealtimeSupervisor } from "../../platforms/discord/realtime/session.js";
import { LinkedInRealtimeSupervisor } from "../../platforms/linkedin/realtime/session.js";
import { SignalRealtimeSupervisor } from "../../platforms/signal/realtime/session.js";
import { SlackRealtimeSupervisor } from "../../platforms/slack/realtime/session.js";
import { WhatsAppRealtimeSupervisor } from "../../platforms/whatsapp/realtime/session.js";
import { queueNativeTriggeredSync } from "./native-watchers.js";
import type { createRealtimeIngest } from "./realtime-ingest.js";
import {
  blockDiscordIntegration,
  collectDesiredDiscordSessions,
  collectDesiredLinkedInSessions,
  collectDesiredSignalSessions,
  collectDesiredSlackSessions,
  collectDesiredWhatsAppSessions,
} from "./realtime-sessions.js";
import { now } from "./settings.js";
import type { AutoSyncPacing } from "./sync-pacing.js";

const linkedInLogger = createLogger("linkedin");
const discordLogger = createLogger("discord");
const slackLogger = createLogger("slack");
const signalLogger = createLogger("signal");
const whatsAppLogger = createLogger("whatsapp");

type RealtimeIngestHandlers = ReturnType<typeof createRealtimeIngest>;

/** What the realtime supervisors read from the daemon that runs them. */
export type RealtimeSupervisorsDeps = {
  db: CuedDatabase;
  schedulers: { wakeIngest: (delayMs?: number) => void };
  autoSyncPacing: AutoSyncPacing;
  shouldRunRealtimePlatform: (platform: AdapterPlatform) => boolean;
  signalReconnectSyncCooldownMs: number;
  handleSlackRealtimeEvent: RealtimeIngestHandlers["handleSlackRealtimeEvent"];
  handleDiscordRealtimeEvent: RealtimeIngestHandlers["handleDiscordRealtimeEvent"];
  ingestLinkedInRealtimeEnvelope: RealtimeIngestHandlers["ingestLinkedInRealtimeEnvelope"];
  ingestSignalRealtimeMessages: RealtimeIngestHandlers["ingestSignalRealtimeMessages"];
  handleWhatsAppRealtimeEvent: RealtimeIngestHandlers["handleWhatsAppRealtimeEvent"];
};

/**
 * The Discord, Slack, LinkedIn, Signal and WhatsApp realtime supervisors, and the reconcile
 * loops that start and stop their sessions to match the authenticated integrations.
 */
export function createRealtimeSupervisors(deps: RealtimeSupervisorsDeps) {
  const {
    db,
    schedulers,
    autoSyncPacing,
    shouldRunRealtimePlatform,
    signalReconnectSyncCooldownMs,
    handleSlackRealtimeEvent,
    handleDiscordRealtimeEvent,
    ingestLinkedInRealtimeEnvelope,
    ingestSignalRealtimeMessages,
    handleWhatsAppRealtimeEvent,
  } = deps;
  const lastSignalReconnectSyncQueuedAt = new Map<string, number>();
  const suppressNextSignalReconnectSync = new Set<string>();
  let discordRealtimeReconcilePromise: Promise<void> | null = null;
  let discordRealtimeReconcileQueued = false;
  let linkedInRealtimeReconcilePromise: Promise<void> | null = null;
  let linkedInRealtimeReconcileQueued = false;
  let slackRealtimeReconcilePromise: Promise<void> | null = null;
  let slackRealtimeReconcileQueued = false;
  let signalRealtimeReconcilePromise: Promise<void> | null = null;
  let signalRealtimeReconcileQueued = false;
  let whatsAppRealtimeReconcilePromise: Promise<void> | null = null;
  let whatsAppRealtimeReconcileQueued = false;

  const runSignalSyncExclusively = async <T>(
    accountKey: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const activeSession = signalRealtime.getSession(accountKey);
    if (!activeSession) {
      return await task();
    }

    suppressNextSignalReconnectSync.add(accountKey);
    await signalRealtime.stopSession(accountKey);

    try {
      return await task();
    } finally {
      requestSignalRealtimeReconcile();
    }
  };

  const discordRealtime = new DiscordRealtimeSupervisor({
    onEvent: (accountKey, event) => {
      autoSyncPacing.reset(`discord:${accountKey}`);
      void handleDiscordRealtimeEvent(accountKey, event);
    },
    onAuthInvalidated: (accountKey, _status, reason) => {
      blockDiscordIntegration(db, accountKey, reason);
      requestDiscordRealtimeReconcile();
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "discord",
        accountKey,
        "discord_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const slackRealtime = new SlackRealtimeSupervisor({
    onEvent: (accountKey, event) => {
      autoSyncPacing.reset(`slack:${accountKey}`);
      void handleSlackRealtimeEvent(accountKey, event);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "slack",
        accountKey,
        "slack_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const linkedInRealtime = new LinkedInRealtimeSupervisor({
    onEvent: (accountKey, event, userEntityUrn) => {
      autoSyncPacing.reset(`linkedin:${accountKey}`);
      void ingestLinkedInRealtimeEnvelope(accountKey, event, userEntityUrn);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "linkedin",
        accountKey,
        "linkedin_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const signalRealtime = new SignalRealtimeSupervisor({
    onMessage: (accountKey, message) => {
      autoSyncPacing.reset(`signal:${accountKey}`);
      void ingestSignalRealtimeMessages(accountKey, [message]);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      if (suppressNextSignalReconnectSync.has(accountKey)) {
        suppressNextSignalReconnectSync.delete(accountKey);
        return;
      }
      const queuedAt = now();
      const lastQueuedAt = lastSignalReconnectSyncQueuedAt.get(accountKey) ?? 0;
      if (queuedAt - lastQueuedAt < signalReconnectSyncCooldownMs) {
        return;
      }
      lastSignalReconnectSyncQueuedAt.set(accountKey, queuedAt);
      queueNativeTriggeredSync(
        db,
        "signal",
        accountKey,
        "signal_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const whatsAppRealtime = new WhatsAppRealtimeSupervisor({
    recoverMissingSession: () => requestWhatsAppRealtimeReconcile(),
    onEvent: (accountKey, event) => {
      autoSyncPacing.reset(`whatsapp:${accountKey}`);
      void handleWhatsAppRealtimeEvent(accountKey, event);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "whatsapp",
        accountKey,
        "whatsapp_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });

  const reconcileSlackRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredSlackSessions(db);
    slackRealtime.reconcile(desired, degraded);
  };

  const reconcileDiscordRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredDiscordSessions(db);
    discordRealtime.reconcile(desired, degraded);
  };

  const requestDiscordRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("discord")) {
      discordRealtime.stopAll();
      return;
    }
    if (discordRealtimeReconcilePromise) {
      discordRealtimeReconcileQueued = true;
      return;
    }

    discordRealtimeReconcilePromise = reconcileDiscordRealtimeSessions()
      .catch((error) => {
        discordLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        discordRealtimeReconcilePromise = null;
        if (discordRealtimeReconcileQueued) {
          discordRealtimeReconcileQueued = false;
          requestDiscordRealtimeReconcile();
        }
      });
  };

  const requestSlackRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("slack")) {
      slackRealtime.stopAll();
      return;
    }
    if (slackRealtimeReconcilePromise) {
      slackRealtimeReconcileQueued = true;
      return;
    }

    slackRealtimeReconcilePromise = reconcileSlackRealtimeSessions()
      .catch((error) => {
        slackLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        slackRealtimeReconcilePromise = null;
        if (slackRealtimeReconcileQueued) {
          slackRealtimeReconcileQueued = false;
          requestSlackRealtimeReconcile();
        }
      });
  };

  const reconcileLinkedInRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredLinkedInSessions(db);
    linkedInRealtime.reconcile(desired, degraded);
  };

  const requestLinkedInRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("linkedin")) {
      linkedInRealtime.stopAll();
      return;
    }
    if (linkedInRealtimeReconcilePromise) {
      linkedInRealtimeReconcileQueued = true;
      return;
    }

    linkedInRealtimeReconcilePromise = reconcileLinkedInRealtimeSessions()
      .catch((error) => {
        linkedInLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        linkedInRealtimeReconcilePromise = null;
        if (linkedInRealtimeReconcileQueued) {
          linkedInRealtimeReconcileQueued = false;
          requestLinkedInRealtimeReconcile();
        }
      });
  };

  const reconcileSignalRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredSignalSessions(db);
    signalRealtime.reconcile(desired, degraded);
  };

  const requestSignalRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("signal")) {
      signalRealtime.stopAll();
      return;
    }
    if (signalRealtimeReconcilePromise) {
      signalRealtimeReconcileQueued = true;
      return;
    }

    signalRealtimeReconcilePromise = reconcileSignalRealtimeSessions()
      .catch((error) => {
        signalLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        signalRealtimeReconcilePromise = null;
        if (signalRealtimeReconcileQueued) {
          signalRealtimeReconcileQueued = false;
          requestSignalRealtimeReconcile();
        }
      });
  };

  const reconcileWhatsAppRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredWhatsAppSessions(db);
    whatsAppRealtime.reconcile(desired, degraded);
  };

  const requestWhatsAppRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("whatsapp")) {
      whatsAppRealtime.stopAll();
      return;
    }
    if (whatsAppRealtimeReconcilePromise) {
      whatsAppRealtimeReconcileQueued = true;
      return whatsAppRealtimeReconcilePromise;
    }

    whatsAppRealtimeReconcilePromise = reconcileWhatsAppRealtimeSessions()
      .catch((error) => {
        whatsAppLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        whatsAppRealtimeReconcilePromise = null;
        if (whatsAppRealtimeReconcileQueued) {
          whatsAppRealtimeReconcileQueued = false;
          requestWhatsAppRealtimeReconcile();
        }
      });
    return whatsAppRealtimeReconcilePromise;
  };

  return {
    discordRealtime,
    slackRealtime,
    linkedInRealtime,
    signalRealtime,
    whatsAppRealtime,
    requestDiscordRealtimeReconcile,
    requestSlackRealtimeReconcile,
    requestLinkedInRealtimeReconcile,
    requestSignalRealtimeReconcile,
    requestWhatsAppRealtimeReconcile,
    runSignalSyncExclusively,
  };
}
