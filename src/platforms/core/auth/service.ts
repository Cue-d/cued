import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { CuedDatabase } from "../../../db/database.js";
import {
  errorTelemetryProperties,
  safeTelemetryValue,
  sendTelemetryEventSafe,
} from "../../../telemetry/context.js";
import { inspectGoogleOAuthClientConfig } from "../../gmail/oauth/client.js";
import {
  importLinkedInStoredAuthAsync,
  validateLinkedInStoredAuth,
} from "../../linkedin/auth/keychain-import.js";
import { importSlackDesktopAuth } from "../../slack/auth/desktop-import.js";
import { SLACK_PENDING_ACCOUNT_KEY_PREFIX } from "../../slack/auth/workspace-selection.js";
import { resolveIntegrationAccountKey } from "../account-keys.js";
import {
  completeAuthSession,
  connectIntegration,
  disconnectIntegration,
  markAuthSessionInProgress,
  removeIntegration,
  setIntegrationEnabled,
} from "../state/mutations.js";
import { refreshManagedIntegrationStates } from "../state/refresh.js";
import {
  buildIntegrationStatus,
  getAuthSessionSummary,
  getIntegrationSummary,
  listRequestableIntegrationPlatforms,
  reconcileAbandonedAuthSessions,
  refreshPersistedRequestableIntegrationStates,
} from "../state/status.js";
import { getDefaultAccountKeyForPlatform, type Platform, parsePlatform } from "../types.js";
import { runAuthSessionSync, startAuthSession } from "./runtime.js";

export type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";

type RuntimeAuthSessionMap = Map<
  string,
  { child: ChildProcess; platform: Platform; accountKey: string }
>;

type ConnectLifecycle = {
  emitAuthenticatedHook?: (platform: string, accountKey: string) => Promise<void> | void;
  shouldQueueAuthenticatedSync?: (platform: Platform, accountKey: string) => boolean;
  wakeIngest?: () => void;
  onRuntimeStateChanged?: () => void;
  /** Sign-in browser progress changed (finding, downloading, launching). Must be cheap. */
  onRuntimeProgress?: () => void;
};

const GMAIL_PENDING_ACCOUNT_KEY_PREFIX = "pending-gmail-";

function assertConnectPreflight(platform: string) {
  const normalized = parsePlatform(platform.trim().toLowerCase());
  if (normalized !== "gmail") {
    return;
  }
  const googleOAuthClient = inspectGoogleOAuthClientConfig();
  if (!googleOAuthClient.available) {
    throw new Error(
      `Google OAuth client is not configured at ${googleOAuthClient.filePath}: ${googleOAuthClient.error}`,
    );
  }
}

/**
 * Managed connects that have been requested and not yet handed back, by account. A second
 * request for the same account (a retry, or a client that timed out and asked again through
 * another transport) joins the first instead of launching a second sign-in.
 */
const managedConnectsInFlight = new Map<string, Promise<unknown>>();

export class IntegrationAuthService {
  constructor(
    private readonly db: CuedDatabase,
    private readonly options: {
      /**
       * A short-lived CLI process waits for telemetry so the event is not lost at exit. The
       * daemon must not: awaiting a network round trip here delayed opening the sign-in
       * window, and the first sync after sign-in, by however long the request took.
       */
      awaitTelemetry?: boolean;
    } = {},
  ) {}

  private async telemetry(
    ...args: Parameters<typeof sendTelemetryEventSafe> extends [CuedDatabase, ...infer Rest]
      ? Rest
      : never
  ): Promise<void> {
    const sent = sendTelemetryEventSafe(this.db, ...args);
    if (this.options.awaitTelemetry ?? true) {
      await sent;
    }
  }

  static usageText(): string {
    return `Usage: cued integrations list | status | capabilities | refresh | interaction start [--session-id <id>] [--ttl-ms <ms>] | interaction end [--session-id <id>] | connect <platform> [account] | disconnect <platform> [account] | remove <platform> [account] | enable <platform> [account] | disable <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`;
  }

  usage(): string {
    return IntegrationAuthService.usageText();
  }

  listStatus(options: { includeDiagnostics?: boolean } = {}) {
    reconcileAbandonedAuthSessions(this.db);
    return buildIntegrationStatus(this.db, options);
  }

  async refresh() {
    reconcileAbandonedAuthSessions(this.db);
    return refreshManagedIntegrationStates(this.db);
  }

  enable(platform: string, accountKey?: string) {
    return setIntegrationEnabled(this.db, platform, accountKey, true);
  }

  disable(platform: string, accountKey?: string) {
    return setIntegrationEnabled(this.db, platform, accountKey, false);
  }

  disconnect(platform: string, accountKey?: string) {
    return disconnectIntegration(this.db, platform, accountKey);
  }

  remove(platform: string, accountKey?: string, options?: { deferSyncRunHistory?: boolean }) {
    return removeIntegration(this.db, platform, accountKey, options);
  }

  async connectLocally(
    platform: string,
    accountKey?: string,
    lifecycle: ConnectLifecycle = {},
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary> | null;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    reconcileAbandonedAuthSessions(this.db);
    const reusable = await this.connectReusableAuth(platform, accountKey, lifecycle);
    if (reusable) {
      return reusable;
    }

    assertConnectPreflight(platform);
    const requested = connectIntegration(this.db, platform, accountKey);
    await this.telemetry("integration_setup_started", {
      component: "integration_auth",
      operation: "connect_local",
      stage: "start",
      platform: requested.integration.platform,
    });
    const running = markAuthSessionInProgress(this.db, requested.authSession.id, process.pid);

    try {
      const integration = getIntegrationSummary(
        this.db,
        requested.integration.platform,
        requested.integration.accountKey,
      );
      const result = await runAuthSessionSync(this.db, running, integration);
      return this.completeAndSchedule(
        running.id,
        {
          state: result.state,
          keychainService: result.keychainService ?? null,
          keychainAccount: result.keychainAccount ?? null,
          resultSummary: result.resultSummary ?? null,
          errorSummary: result.errorSummary ?? null,
        },
        lifecycle,
      );
    } catch (error) {
      await this.telemetry("integration_setup_failed", {
        component: "integration_auth",
        operation: "connect_local",
        stage: "runtime",
        platform: requested.integration.platform,
        ...errorTelemetryProperties(error, "integration_setup_failed"),
      });
      return this.completeAndSchedule(
        running.id,
        {
          state: "failed",
          errorSummary: error instanceof Error ? error.message : String(error),
        },
        lifecycle,
      );
    }
  }

  connectManaged(
    platform: string,
    accountKey: string | undefined,
    activeAuthSessions: RuntimeAuthSessionMap,
    lifecycle: ConnectLifecycle = {},
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary>;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    type Started = Awaited<ReturnType<IntegrationAuthService["startManagedConnect"]>>;
    const key = `${platform.trim().toLowerCase()}\u0000${accountKey ?? ""}`;
    const inFlight = managedConnectsInFlight.get(key) as Promise<Started> | undefined;
    if (inFlight) {
      return inFlight;
    }
    const started = this.startManagedConnect(
      platform,
      accountKey,
      activeAuthSessions,
      lifecycle,
    ).finally(() => {
      managedConnectsInFlight.delete(key);
    });
    managedConnectsInFlight.set(key, started);
    return started;
  }

  private async startManagedConnect(
    platform: string,
    accountKey: string | undefined,
    activeAuthSessions: RuntimeAuthSessionMap,
    lifecycle: ConnectLifecycle,
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary>;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    reconcileAbandonedAuthSessions(this.db);
    const active = this.findActiveManagedAuthSession(platform, accountKey, activeAuthSessions);
    if (active) {
      return active;
    }

    const reusable = await this.connectReusableAuth(platform, accountKey, lifecycle);
    if (reusable?.integration) {
      return {
        integration: reusable.integration,
        authSession: reusable.authSession,
      };
    }
    // Looking for reusable auth can take seconds; a sign-in may have started meanwhile.
    const startedMeanwhile = this.findActiveManagedAuthSession(
      platform,
      accountKey,
      activeAuthSessions,
    );
    if (startedMeanwhile) {
      return startedMeanwhile;
    }

    assertConnectPreflight(platform);
    const requested = connectIntegration(this.db, platform, accountKey);
    await this.telemetry("integration_setup_started", {
      component: "integration_auth",
      operation: "connect_managed",
      stage: "start",
      platform: requested.integration.platform,
    });
    const integration = getIntegrationSummary(
      this.db,
      requested.integration.platform,
      requested.integration.accountKey,
    );
    const runtime = startAuthSession(this.db, requested.authSession, integration, {
      onProgress: lifecycle.onRuntimeProgress,
    });
    const running = markAuthSessionInProgress(
      this.db,
      requested.authSession.id,
      runtime.child.pid ?? process.pid,
    );

    activeAuthSessions.set(running.id, {
      child: runtime.child,
      platform: running.platform,
      accountKey: running.accountKey,
    });

    runtime.completion
      .then(async (result) => {
        await this.completeAndSchedule(
          running.id,
          {
            state: result.state,
            keychainService: result.keychainService ?? null,
            keychainAccount: result.keychainAccount ?? null,
            resultSummary: result.resultSummary ?? null,
            errorSummary: result.errorSummary ?? null,
          },
          lifecycle,
        );
        lifecycle.onRuntimeStateChanged?.();
      })
      .catch(async (error) => {
        await this.telemetry("integration_setup_failed", {
          component: "integration_auth",
          operation: "connect_managed",
          stage: "runtime",
          platform: running.platform,
          ...errorTelemetryProperties(error, "integration_setup_failed"),
        });
        const latest = this.db.getAuthSession(running.id);
        if (latest?.state !== "cancelled") {
          await this.completeAndSchedule(
            running.id,
            {
              state: "failed",
              errorSummary: error instanceof Error ? error.message : String(error),
            },
            lifecycle,
          );
        }
        lifecycle.onRuntimeStateChanged?.();
      })
      .finally(() => {
        activeAuthSessions.delete(running.id);
      });

    return {
      integration: getIntegrationSummary(
        this.db,
        requested.integration.platform,
        requested.integration.accountKey,
      ),
      authSession: getAuthSessionSummary(this.db, running.id),
    };
  }

  private findActiveManagedAuthSession(
    platform: string,
    accountKey: string | undefined,
    activeAuthSessions: RuntimeAuthSessionMap,
  ): {
    integration: ReturnType<typeof getIntegrationSummary>;
    authSession: NonNullable<ReturnType<typeof getAuthSessionSummary>>;
  } | null {
    const normalized = parsePlatform(platform.trim().toLowerCase());
    if (!normalized) {
      return null;
    }
    const resolvedAccountKey = resolveIntegrationAccountKey(
      accountKey,
      getDefaultAccountKeyForPlatform(normalized),
    );
    const generatedPendingPrefix =
      normalized === "slack" && resolvedAccountKey.startsWith(SLACK_PENDING_ACCOUNT_KEY_PREFIX)
        ? SLACK_PENDING_ACCOUNT_KEY_PREFIX
        : normalized === "gmail" && resolvedAccountKey.startsWith(GMAIL_PENDING_ACCOUNT_KEY_PREFIX)
          ? GMAIL_PENDING_ACCOUNT_KEY_PREFIX
          : null;

    for (const [sessionId, runtime] of activeAuthSessions) {
      const sameAccount =
        runtime.accountKey === resolvedAccountKey ||
        (generatedPendingPrefix !== null && runtime.accountKey.startsWith(generatedPendingPrefix));
      if (runtime.platform !== normalized || !sameAccount) {
        continue;
      }
      if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
        activeAuthSessions.delete(sessionId);
        continue;
      }
      const authSession = getAuthSessionSummary(this.db, sessionId);
      if (
        !authSession ||
        (authSession.state !== "requested" && authSession.state !== "in_progress")
      ) {
        activeAuthSessions.delete(sessionId);
        continue;
      }
      return {
        integration: getIntegrationSummary(this.db, normalized, runtime.accountKey),
        authSession,
      };
    }

    if (generatedPendingPrefix !== null) {
      const authSession = this.db
        .listAuthSessions(100)
        .find(
          (session) =>
            session.platform === normalized &&
            session.account_key.startsWith(generatedPendingPrefix) &&
            (session.state === "requested" || session.state === "in_progress"),
        );
      if (authSession) {
        return {
          integration: getIntegrationSummary(this.db, normalized, authSession.account_key),
          authSession: getAuthSessionSummary(this.db, authSession.id)!,
        };
      }
    }

    return null;
  }

  private async completeAndSchedule(
    sessionId: string,
    input: Parameters<typeof completeAuthSession>[2],
    lifecycle: ConnectLifecycle,
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary> | null;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    const completed = completeAuthSession(this.db, sessionId, input);
    let integration = completed.integration;
    if (integration?.authState === "authenticated") {
      await this.telemetry("integration_setup_completed", {
        component: "integration_auth",
        operation: "complete",
        stage: "authenticated",
        platform: integration.platform,
      });
      refreshPersistedRequestableIntegrationStates(this.db);
      integration = getIntegrationSummary(this.db, integration.platform, integration.accountKey);
    } else if (
      completed.authSession?.state === "failed" ||
      completed.authSession?.state === "cancelled"
    ) {
      await this.telemetry("integration_setup_failed", {
        component: "integration_auth",
        operation: "complete",
        stage: completed.authSession.state,
        platform: completed.authSession.platform,
        result: completed.authSession.state,
        runtime_kind: integration?.runtimeKind,
        ...errorTelemetryProperties(
          input.errorSummary ?? `auth ${completed.authSession.state}`,
          "integration_setup_failed",
        ),
        ...authResultErrorTelemetry(input.resultSummary),
      });
    }

    if (
      integration?.authState === "authenticated" &&
      integration.syncCapable &&
      (lifecycle.shouldQueueAuthenticatedSync?.(integration.platform, integration.accountKey) ??
        true)
    ) {
      if (!this.db.hasQueuedOrRunningRun(integration.platform, integration.accountKey)) {
        this.db.queueSyncRun({
          platform: integration.platform,
          accountKey: integration.accountKey,
          runType: "sync",
          trigger: "integration_authenticated",
          details: {
            source: integration.platform,
            accountKey: integration.accountKey,
            trigger: "integration_authenticated",
          },
        });
        lifecycle.wakeIngest?.();
      }
    }

    if (integration?.authState === "authenticated") {
      await lifecycle.emitAuthenticatedHook?.(integration.platform, integration.accountKey);
    }

    return {
      integration,
      authSession: completed.authSession,
    };
  }

  private async connectReusableAuth(
    platform: string,
    accountKey: string | undefined,
    lifecycle: ConnectLifecycle,
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary> | null;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  } | null> {
    const normalized = parsePlatform(platform.trim().toLowerCase());
    if (normalized !== "slack" && normalized !== "linkedin") {
      return null;
    }

    const slackPendingDiscoveryRequest =
      normalized === "slack" && accountKey?.startsWith(SLACK_PENDING_ACCOUNT_KEY_PREFIX) === true;
    const previouslyAuthenticatedSlackAccounts = slackPendingDiscoveryRequest
      ? new Set(
          this.db
            .listIntegrationStates()
            .filter((row) => row.platform === "slack" && row.auth_state === "authenticated")
            .map((row) => row.account_key),
        )
      : new Set<string>();

    if (normalized === "slack") {
      await importSlackDesktopAuth(this.db, {
        skipWhenAnyAuthenticated: false,
        reviveUserRemoved: true,
        reconnectInvalidated: true,
      }).catch(() => []);
    } else {
      await importLinkedInStoredAuthAsync(this.db, { reviveUserRemoved: true });
    }

    const reusableAccountKey = slackPendingDiscoveryRequest ? undefined : accountKey;
    const reusable = this.findReusableAuthenticatedIntegration(
      normalized,
      reusableAccountKey,
      slackPendingDiscoveryRequest ? previouslyAuthenticatedSlackAccounts : undefined,
    );
    if (!reusable) {
      return null;
    }

    const metadata = reusable.metadata ?? {};
    const keychainService =
      typeof metadata.keychainService === "string" ? metadata.keychainService : null;
    const keychainAccount =
      typeof metadata.keychainAccount === "string" ? metadata.keychainAccount : null;
    if (!keychainService || !keychainAccount) {
      return null;
    }
    if (reusable.platform === "linkedin") {
      const validation = await validateLinkedInStoredAuth(reusable.accountKey);
      if (validation.status === "invalid") {
        return null;
      }
      if (validation.status === "indeterminate") {
        throw new Error(
          `Could not verify the existing LinkedIn session: ${validation.errorSummary}`,
        );
      }
    }
    const previousAuthResult =
      typeof metadata.authResult === "object" && metadata.authResult
        ? (metadata.authResult as Record<string, unknown>)
        : {};
    const resultSummary = {
      ...previousAuthResult,
      provider: reusable.platform,
      source: "reused_existing_auth",
      importedFrom: reusable.importedFrom,
      displayName: reusable.displayName,
    };

    const sessionId = this.db.createAuthSession({
      platform: reusable.platform,
      accountKey: reusable.accountKey,
      integrationStateId: `${reusable.platform}:${reusable.accountKey}`,
      state: "requested",
      resultSummary,
    });
    markAuthSessionInProgress(this.db, sessionId, process.pid);

    return this.completeAndSchedule(
      sessionId,
      {
        state: "authenticated",
        keychainService,
        keychainAccount,
        resultSummary,
      },
      lifecycle,
    );
  }

  private findReusableAuthenticatedIntegration(
    platform: Extract<Platform, "slack" | "linkedin">,
    accountKey?: string,
    excludeAccountKeys: ReadonlySet<string> = new Set(),
  ): ReturnType<typeof getIntegrationSummary> | null {
    const rows = this.db
      .listIntegrationStates()
      .filter(
        (row) =>
          row.platform === platform &&
          row.auth_state === "authenticated" &&
          !excludeAccountKeys.has(row.account_key) &&
          (accountKey ? row.account_key === accountKey : true),
      )
      .sort((left, right) => {
        const leftImported = left.imported_from === "slack-desktop-cdp";
        const rightImported = right.imported_from === "slack-desktop-cdp";
        if (leftImported !== rightImported) {
          return leftImported ? -1 : 1;
        }
        return right.updated_at - left.updated_at;
      });

    const first = rows[0];
    return first ? getIntegrationSummary(this.db, first.platform, first.account_key) : null;
  }
}

function authResultErrorTelemetry(resultSummary: Record<string, unknown> | null | undefined) {
  const errorCode =
    typeof resultSummary?.errorCode === "string"
      ? safeTelemetryValue(resultSummary.errorCode, "integration_setup_failed")
      : null;
  const phase =
    typeof resultSummary?.phase === "string"
      ? safeTelemetryValue(resultSummary.phase, "unknown")
      : typeof resultSummary?.stage === "string"
        ? safeTelemetryValue(resultSummary.stage, "unknown")
        : null;
  return {
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(phase ? { phase } : {}),
  };
}
