import {
  type AdapterPlatform,
  getDefaultAccountKeyForPlatform,
  isAdapterPlatform,
  isPlatform,
} from "../core/types/provider.js";
import type { ContactMergeBatchInput, CuedDatabase } from "../db/database.js";
import { rebuildProjectedState } from "./projection/projector.js";

type RunQueueSchedulers = {
  wakeIngest?: () => void;
  wakeProjection?: () => void;
};

export type SyncRunQueueResult = {
  /** Whether any run was queued or brought forward. */
  queued: boolean;
  runId: string | null;
  runIds: string[];
  /** The `platform:account` targets a run was queued or brought forward for. */
  targets: string[];
  /** Targets skipped because a run of theirs is already queued or running. */
  alreadyQueued: string[];
  message: string;
};

export class RunQueueService {
  constructor(
    private readonly db: CuedDatabase,
    private readonly schedulers: RunQueueSchedulers = {},
  ) {}

  private listManualSyncTargets(source?: AdapterPlatform): string[] {
    const syncCapableTargets = this.db
      .listEnabledSyncTargets()
      .filter(
        (target): target is { platform: AdapterPlatform; account_key: string } =>
          isAdapterPlatform(target.platform) && (source == null || target.platform === source),
      )
      .map((target) => `${target.platform}:${target.account_key}`);
    const syncCapablePlatforms = new Set(
      syncCapableTargets.map((targetKey) => targetKey.slice(0, targetKey.indexOf(":"))),
    );

    // A platform with a sync-capable account syncs those accounts; otherwise its enabled,
    // authenticated accounts are tried, as their sync capability may only be stale.
    const authenticatedTargets = this.db
      .listIntegrationStates()
      .filter(
        (integration) =>
          isAdapterPlatform(integration.platform) &&
          (source == null || integration.platform === source) &&
          !syncCapablePlatforms.has(integration.platform) &&
          integration.enabled === 1 &&
          (integration.auth_state === "authenticated" || integration.auth_state === "authorized"),
      )
      .map((integration) => `${integration.platform}:${integration.account_key}`);
    return [...new Set([...syncCapableTargets, ...authenticatedTargets])];
  }

  /**
   * Queues a sync for one source's connected accounts, or for every connected account when no
   * source is given. A target that already has a run queued or running gets no second one; a
   * battery-delayed run of its is brought forward instead.
   */
  queueSyncRun(source?: string): SyncRunQueueResult {
    if (source === "whatsapp-desktop") {
      const accountKey = getDefaultAccountKeyForPlatform("whatsapp");
      if (this.db.hasQueuedOrRunningRun("whatsapp", accountKey)) {
        return {
          queued: false,
          runId: null,
          runIds: [],
          targets: [],
          alreadyQueued: ["whatsapp-desktop"],
          message: "A WhatsApp sync is already queued or running.",
        };
      }
      const runId = this.db.queueSyncRun({
        platform: "whatsapp",
        accountKey,
        runType: "sync",
        trigger: "cli",
        details: { source: "whatsapp_desktop", accountKey },
      });
      this.schedulers.wakeIngest?.();
      return {
        queued: true,
        runId,
        runIds: [runId],
        targets: ["whatsapp-desktop"],
        alreadyQueued: [],
        message: "Queued a WhatsApp Desktop sync.",
      };
    }

    if (source && !isAdapterPlatform(source)) {
      throw new Error(`Unsupported sync source: ${source}`);
    }
    const sourcePlatform = source && isAdapterPlatform(source) ? source : undefined;

    const queuedTargets: string[] = [];
    const alreadyQueued: string[] = [];
    const expeditedRunIds: string[] = [];
    const runInputs = this.listManualSyncTargets(sourcePlatform).flatMap((targetKey) => {
      const parsedTarget = parseRunTargetKey(targetKey);
      if (!parsedTarget) {
        return [];
      }
      const { platform, accountKey } = parsedTarget;
      if (this.db.hasQueuedOrRunningRun(platform, accountKey)) {
        const expedited = this.db.expeditePowerDeferredSyncRun(platform, accountKey);
        if (expedited) {
          expeditedRunIds.push(expedited);
          queuedTargets.push(targetKey);
        } else {
          alreadyQueued.push(targetKey);
        }
        return [];
      }

      queuedTargets.push(targetKey);
      return [
        {
          platform,
          accountKey,
          runType: "sync" as const,
          trigger: "cli",
          details: { source: platform, accountKey },
        },
      ];
    });

    const runIds = [...expeditedRunIds, ...this.db.queueSyncRuns(runInputs)];
    if (runIds.length > 0) {
      this.schedulers.wakeIngest?.();
    }

    return {
      queued: runIds.length > 0,
      runId: runIds[0] ?? null,
      runIds,
      targets: queuedTargets,
      alreadyQueued,
      message: describeSyncRunQueueResult(
        sourcePlatform,
        queuedTargets.length,
        alreadyQueued.length,
      ),
    };
  }

  queueSyncResume(targets: Array<{ platform: AdapterPlatform; accountKey: string }>): {
    queued: boolean;
    runIds: string[];
    targets: string[];
  } {
    const uniqueTargets = new Set(
      targets.map((target) => `${target.platform}:${target.accountKey}`),
    );
    const runIds: string[] = [];

    for (const targetKey of uniqueTargets) {
      const parsedTarget = parseRunTargetKey(targetKey);
      if (!parsedTarget) {
        continue;
      }
      const { platform, accountKey } = parsedTarget;
      if (!platform || !accountKey || !isAdapterPlatform(platform)) {
        continue;
      }
      if (this.db.hasQueuedOrRunningRun(platform, accountKey)) {
        const expedited = this.db.expeditePowerDeferredSyncRun(platform, accountKey);
        if (expedited) {
          runIds.push(expedited);
        }
        continue;
      }

      runIds.push(
        this.db.queueSyncRun({
          platform,
          accountKey,
          runType: "sync_resume",
          trigger: "cli",
          details: { source: platform, accountKey },
        }),
      );
    }

    if (runIds.length > 0) {
      this.schedulers.wakeIngest?.();
    }

    return {
      queued: runIds.length > 0,
      runIds,
      targets: [...uniqueTargets],
    };
  }

  queueRebuild(): {
    queued: true;
    runId: string;
  } {
    const runId = this.db.queueSyncRun({
      runType: "rebuild",
      trigger: "cli",
      details: { trigger: "cli" },
    });
    this.schedulers.wakeProjection?.();

    return {
      queued: true,
      runId,
    };
  }

  resetSource(source: string): {
    source: string;
    rowsRemoved: number;
    rebuildQueued: false;
  } {
    if (!isPlatform(source)) {
      throw new Error(`Unsupported reset source: ${source}`);
    }

    const rowsRemoved = this.db.resetSource(source);
    const result = {
      source,
      rowsRemoved,
      rebuildQueued: false as const,
    };
    this.schedulers.wakeProjection?.();
    return result;
  }

  mergeContacts(input: { primaryContactId: string; secondaryContactId: string; reason?: string }): {
    merged: true;
    decisionId: string;
    primaryContactId: string;
    secondaryContactId: string;
    canonicalContactId: string;
    projection: ReturnType<typeof rebuildProjectedState>;
  } {
    const decision = this.db.recordContactMergeDecision({
      primaryContactId: input.primaryContactId,
      secondaryContactId: input.secondaryContactId,
      reason: input.reason ?? null,
      createdBy: "cli",
    });
    const projection = rebuildProjectedState(this.db);

    return {
      merged: true,
      decisionId: decision.decisionId,
      primaryContactId: decision.primaryContactId,
      secondaryContactId: decision.secondaryContactId,
      canonicalContactId: decision.canonicalContactId,
      projection,
    };
  }

  mergeContactsBatch(input: { merges: ContactMergeBatchInput[]; apply: boolean }): {
    applied: boolean;
    mergeCount: number;
    decisions: ReturnType<CuedDatabase["planContactMergeDecisions"]>;
    projection?: ReturnType<typeof rebuildProjectedState>;
  } {
    if (!input.apply) {
      const decisions = this.db.planContactMergeDecisions(input.merges);
      return {
        applied: false,
        mergeCount: decisions.length,
        decisions,
      };
    }

    const decisions = this.db.recordContactMergeDecisionsBatch(input.merges, { createdBy: "cli" });
    const projection = rebuildProjectedState(this.db);
    return {
      applied: true,
      mergeCount: decisions.length,
      decisions,
      projection,
    };
  }
}

function describeSyncRunQueueResult(
  source: string | undefined,
  queuedCount: number,
  alreadyQueuedCount: number,
): string {
  const scope = source ? `${source} ` : "";
  if (queuedCount === 0 && alreadyQueuedCount === 0) {
    return `No connected ${scope}account to sync.`;
  }
  if (queuedCount === 0) {
    return alreadyQueuedCount === 1
      ? `A sync is already queued or running for the connected ${scope}account.`
      : `A sync is already queued or running for all ${alreadyQueuedCount} connected ${scope}accounts.`;
  }
  const queued = `Queued a sync for ${queuedCount} ${scope}account${queuedCount === 1 ? "" : "s"}`;
  return alreadyQueuedCount === 0
    ? `${queued}.`
    : `${queued}; ${alreadyQueuedCount} already had one queued or running.`;
}

function parseRunTargetKey(
  targetKey: string,
): { platform: AdapterPlatform; accountKey: string } | null {
  const separatorIndex = targetKey.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= targetKey.length - 1) {
    return null;
  }
  const platform = targetKey.slice(0, separatorIndex);
  const accountKey = targetKey.slice(separatorIndex + 1);
  if (!isAdapterPlatform(platform) || accountKey.length === 0) {
    return null;
  }
  return {
    platform,
    accountKey,
  };
}
