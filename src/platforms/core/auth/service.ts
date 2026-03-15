import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { CuedDatabase } from "../../../db/database.js";
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
} from "../state/status.js";
import type { Platform } from "../types.js";
import { runAuthSessionSync, startAuthSession } from "./runtime.js";

export type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";

type RuntimeAuthSessionMap = Map<
  string,
  { child: ChildProcess; platform: Platform; accountKey: string }
>;

type ConnectLifecycle = {
  emitAuthenticatedHook?: (platform: string, accountKey: string) => Promise<void> | void;
  wakeIngest?: () => void;
  onRuntimeStateChanged?: () => void;
};

export class IntegrationAuthService {
  constructor(private readonly db: CuedDatabase) {}

  static usageText(): string {
    return `Usage: cued integrations list | status | refresh | connect <platform> [account] | disconnect <platform> [account] | remove <platform> [account] | enable <platform> [account] | disable <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`;
  }

  usage(): string {
    return IntegrationAuthService.usageText();
  }

  listStatus() {
    return buildIntegrationStatus(this.db);
  }

  async refresh() {
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

  remove(platform: string, accountKey?: string) {
    return removeIntegration(this.db, platform, accountKey);
  }

  async connectLocally(
    platform: string,
    accountKey?: string,
    lifecycle: ConnectLifecycle = {},
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary> | null;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    const requested = connectIntegration(this.db, platform, accountKey);
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

  async connectManaged(
    platform: string,
    accountKey: string | undefined,
    activeAuthSessions: RuntimeAuthSessionMap,
    lifecycle: ConnectLifecycle = {},
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary>;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    const requested = connectIntegration(this.db, platform, accountKey);
    const integration = getIntegrationSummary(
      this.db,
      requested.integration.platform,
      requested.integration.accountKey,
    );
    const runtime = startAuthSession(this.db, requested.authSession, integration);
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

  private async completeAndSchedule(
    sessionId: string,
    input: Parameters<typeof completeAuthSession>[2],
    lifecycle: ConnectLifecycle,
  ): Promise<{
    integration: ReturnType<typeof getIntegrationSummary> | null;
    authSession: ReturnType<typeof getAuthSessionSummary>;
  }> {
    const completed = completeAuthSession(this.db, sessionId, input);
    if (completed.integration?.authState === "authenticated") {
      if (
        !this.db.hasQueuedOrRunningRun(
          completed.integration.platform,
          completed.integration.accountKey,
        )
      ) {
        this.db.queueSyncRun({
          platform: completed.integration.platform,
          accountKey: completed.integration.accountKey,
          runType: "sync",
          trigger: "integration_authenticated",
          details: {
            source: completed.integration.platform,
            accountKey: completed.integration.accountKey,
            trigger: "integration_authenticated",
          },
        });
        lifecycle.wakeIngest?.();
      }
      await lifecycle.emitAuthenticatedHook?.(
        completed.integration.platform,
        completed.integration.accountKey,
      );
    }

    return {
      integration: completed.integration,
      authSession: completed.authSession,
    };
  }
}
