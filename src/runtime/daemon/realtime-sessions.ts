import process from "node:process";
import { safeParseJsonRecord, safeParseJsonStringArray } from "../../db/codecs.js";
import type { openCuedDatabase } from "../../db/database.js";
import { loadIntegrationSecret } from "../../platforms/core/secrets/keychain.js";
import type { DiscordRealtimeStatus } from "../../platforms/discord/realtime/session.js";
import {
  hasLinkedInRealtimeSessionHeaders,
  loadLinkedInSessionSecret,
} from "../../platforms/linkedin/auth/session-store.js";
import type { LinkedInRealtimeStatus } from "../../platforms/linkedin/realtime/session.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
} from "../../platforms/signal/cli/binary.js";
import type { SignalRealtimeStatus } from "../../platforms/signal/realtime/session.js";
import { inspectSlackHelper } from "../../platforms/slack/helper/binary.js";
import type { SlackRealtimeStatus } from "../../platforms/slack/realtime/session.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
} from "../../platforms/whatsapp/helper/binary.js";
import { readWhatsAppHelperStatus } from "../../platforms/whatsapp/helper/status.js";
import type { WhatsAppRealtimeStatus } from "../../platforms/whatsapp/realtime/session.js";
import {
  DEFAULT_DISCORD_DM_POLL_MS,
  getDiscordRealtimeEnabled,
  getSlackRealtimeEnabled,
  now,
} from "./settings.js";

type SignalDesiredSession = {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
};

type DiscordDesiredSession = {
  accountKey: string;
  credentials: {
    token: string;
  };
  dmPollIntervalMs?: number;
};

type SlackDesiredSession = {
  accountKey: string;
  helperPath: string;
  credentials: {
    token: string;
    cookie: string;
  };
  pollIntervalMs?: number;
  userRefreshMs?: number;
  conversationLimit?: number;
  messageLimit?: number;
};

type WhatsAppDesiredSession = {
  accountKey: string;
  helperPath: string;
  storeDir: string;
};

type LinkedInDesiredSession = {
  accountKey: string;
  cookies: ReturnType<typeof loadLinkedInSessionSecret>["cookies"];
  userAgent: string | null;
  pageInstance: string;
  xLiTrack: string;
  serviceVersion: string | null;
  realtimeQueryMap: string;
  realtimeRecipeMap: string;
};

async function collectDesiredSignalSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: SignalDesiredSession[];
  degraded: Array<Omit<SignalRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "signal" &&
        row.enabled === 1 &&
        row.auth_state === "authenticated" &&
        !db.hasQueuedOrRunningRun("signal", row.account_key),
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = await inspectSignalCli();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<SignalRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    account: "",
    cliPath: inspected.cliPath ?? "",
    configDir: getSignalConfigDir(integration.account_key),
    state: "degraded",
    connectedAt: null,
    lastNotificationAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.cliPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "Bundled Signal helper was not found",
      })),
    };
  }

  if (!isSignalCliVersionSupported(inspected.version)) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: `Bundled Signal helper is too old or invalid (${inspected.version?.raw ?? "unknown"})`,
      })),
    };
  }

  const desired: SignalDesiredSession[] = [];
  const degraded: Array<Omit<SignalRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const configDir = getSignalConfigDir(integration.account_key);
    const account = readSignalLinkedAccount(configDir);
    if (!account) {
      degraded.push({
        ...baseStatus(integration),
        cliPath: inspected.cliPath,
        configDir,
        lastSessionError: "Signal account is not linked in Cued's managed config",
      });
      continue;
    }

    desired.push({
      accountKey: integration.account_key,
      account,
      cliPath: inspected.cliPath,
      configDir,
    });
  }

  return { desired, degraded };
}

async function collectDesiredDiscordSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: DiscordDesiredSession[];
  degraded: Array<Omit<DiscordRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "discord" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0 || !getDiscordRealtimeEnabled()) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const desired: DiscordDesiredSession[] = [];
  const degraded: Array<Omit<DiscordRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    try {
      const secret = loadIntegrationSecret("discord", integration.account_key).secret;
      if (typeof secret.token !== "string" || secret.token.trim().length === 0) {
        degraded.push({
          accountKey: integration.account_key,
          state: "degraded",
          userId: null,
          username: null,
          connectedAt: null,
          lastEventAt: null,
          lastReconnectAt: null,
          reconnectAttempts: 0,
          lastSessionError: "Discord credentials are missing the stored token",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        credentials: {
          token: secret.token,
        },
        dmPollIntervalMs: Number.isFinite(Number(process.env.CUED_DISCORD_DM_POLL_MS))
          ? Number(process.env.CUED_DISCORD_DM_POLL_MS)
          : DEFAULT_DISCORD_DM_POLL_MS,
      });
    } catch (error) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        userId: null,
        username: null,
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}

function blockDiscordIntegration(
  db: ReturnType<typeof openCuedDatabase>,
  accountKey: string,
  errorSummary: string,
): void {
  const integration = db.getIntegrationState("discord", accountKey);
  if (!integration) {
    return;
  }

  const metadata =
    safeParseJsonRecord(integration.metadata_json, "integration_states.metadata_json") ?? {};
  db.upsertIntegrationState({
    platform: "discord",
    accountKey,
    displayName: integration.display_name,
    authState: "blocked",
    enabled: integration.enabled === 1,
    connectionKind: integration.connection_kind,
    syncCapable: false,
    launchStrategy: integration.launch_strategy,
    launchTarget: integration.launch_target,
    importedFrom: integration.imported_from,
    artifactPaths: safeParseJsonStringArray(
      integration.artifact_paths_json,
      "integration_states.artifact_paths_json",
    ),
    metadata: {
      ...metadata,
      lastAuthError: errorSummary,
      blockedAt: now(),
      blockedReason: "discord_auth_invalidated",
    },
  });
  db.recordCheckpointError("discord", accountKey, errorSummary);
}

async function collectDesiredSlackSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: SlackDesiredSession[];
  degraded: Array<Omit<SlackRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) => row.platform === "slack" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0 || !getSlackRealtimeEnabled()) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = inspectSlackHelper();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<SlackRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    helperPath: inspected.helperPath ?? "",
    state: "degraded",
    teamId: null,
    userId: null,
    transport: null,
    connectedAt: null,
    lastEventAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.helperPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "Slack helper was not found",
      })),
    };
  }

  if (!inspected.versionSupported) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: `Slack helper is too old or invalid (${inspected.version ?? "unknown"})`,
      })),
    };
  }

  const desired: SlackDesiredSession[] = [];
  const degraded: Array<Omit<SlackRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    try {
      const secret = loadIntegrationSecret("slack", integration.account_key).secret;
      if (typeof secret.token !== "string" || typeof secret.cookie !== "string") {
        degraded.push({
          ...baseStatus(integration),
          helperPath: inspected.helperPath,
          lastSessionError: "Slack credentials are missing token or cookie",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        helperPath: inspected.helperPath,
        credentials: {
          token: secret.token,
          cookie: secret.cookie,
        },
        pollIntervalMs: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_POLL_MS))
          ? Number(process.env.CUED_SLACK_REALTIME_POLL_MS)
          : undefined,
        userRefreshMs: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_USER_REFRESH_MS))
          ? Number(process.env.CUED_SLACK_REALTIME_USER_REFRESH_MS)
          : undefined,
        conversationLimit: Number.isFinite(
          Number(process.env.CUED_SLACK_REALTIME_CONVERSATION_LIMIT),
        )
          ? Number(process.env.CUED_SLACK_REALTIME_CONVERSATION_LIMIT)
          : undefined,
        messageLimit: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_MESSAGE_LIMIT))
          ? Number(process.env.CUED_SLACK_REALTIME_MESSAGE_LIMIT)
          : undefined,
      });
    } catch (error) {
      degraded.push({
        ...baseStatus(integration),
        helperPath: inspected.helperPath,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}

async function collectDesiredWhatsAppSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: WhatsAppDesiredSession[];
  degraded: Array<Omit<WhatsAppRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "whatsapp" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = inspectWhatsAppHelper();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<WhatsAppRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    helperPath: inspected.helperPath ?? "",
    storeDir: getWhatsAppStoreDir(integration.account_key),
    state: "degraded",
    accountJid: null,
    connectedAt: null,
    lastEventAt: null,
    lastHistorySyncAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.helperPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "WhatsApp helper was not found",
      })),
    };
  }

  const desired: WhatsAppDesiredSession[] = [];
  const degraded: Array<Omit<WhatsAppRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const storeDir = getWhatsAppStoreDir(integration.account_key);
    try {
      const status = await readWhatsAppHelperStatus(storeDir);
      if (!status.authenticated || !status.accountJid) {
        degraded.push({
          ...baseStatus(integration),
          helperPath: inspected.helperPath,
          storeDir,
          lastSessionError: "WhatsApp account is not linked in Cued's managed store",
        });
        continue;
      }
    } catch (error) {
      degraded.push({
        ...baseStatus(integration),
        helperPath: inspected.helperPath,
        storeDir,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    desired.push({
      accountKey: integration.account_key,
      helperPath: inspected.helperPath,
      storeDir,
    });
  }

  return { desired, degraded };
}

function readIntegrationAuthResult(metadataJson: string | null): Record<string, unknown> | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { authResult?: unknown };
    return typeof parsed.authResult === "object" && parsed.authResult !== null
      ? (parsed.authResult as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function collectDesiredLinkedInSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: LinkedInDesiredSession[];
  degraded: Array<Omit<LinkedInRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "linkedin" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const desired: LinkedInDesiredSession[] = [];
  const degraded: Array<Omit<LinkedInRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const authResult = readIntegrationAuthResult(integration.metadata_json);
    if (authResult?.realtimeReady !== true) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: "LinkedIn realtime headers were not captured during auth",
      });
      continue;
    }

    try {
      const session = loadLinkedInSessionSecret(integration.account_key);
      if (!session.cookies.length || !hasLinkedInRealtimeSessionHeaders(session)) {
        degraded.push({
          accountKey: integration.account_key,
          state: "degraded",
          connectedAt: null,
          lastEventAt: null,
          lastReconnectAt: null,
          reconnectAttempts: 0,
          lastSessionError: "LinkedIn realtime session data is incomplete",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        cookies: session.cookies,
        userAgent: session.userAgent,
        pageInstance: session.pageInstance,
        xLiTrack: session.xLiTrack,
        serviceVersion: session.serviceVersion,
        realtimeQueryMap: session.realtimeQueryMap,
        realtimeRecipeMap: session.realtimeRecipeMap,
      });
    } catch (error) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}

export {
  blockDiscordIntegration,
  collectDesiredDiscordSessions,
  collectDesiredLinkedInSessions,
  collectDesiredSignalSessions,
  collectDesiredSlackSessions,
  collectDesiredWhatsAppSessions,
};
