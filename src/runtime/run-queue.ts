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
  wakeOutbound?: () => void;
  wakeProjection?: () => void;
};

export class RunQueueService {
  constructor(
    private readonly db: CuedDatabase,
    private readonly schedulers: RunQueueSchedulers = {},
  ) {}

  private listManualSyncTargets(source: AdapterPlatform): string[] {
    const syncCapableTargets = this.db
      .listEnabledSyncTargets()
      .filter(
        (target): target is { platform: AdapterPlatform; account_key: string } =>
          isAdapterPlatform(target.platform) && target.platform === source,
      )
      .map((target) => `${target.platform}:${target.account_key}`);
    if (syncCapableTargets.length > 0) {
      return [...new Set(syncCapableTargets)];
    }

    const authenticatedTargets = this.db
      .listIntegrationStates()
      .filter(
        (integration) =>
          integration.platform === source &&
          integration.enabled === 1 &&
          (integration.auth_state === "authenticated" || integration.auth_state === "authorized"),
      )
      .map((integration) => `${integration.platform}:${integration.account_key}`);
    return [...new Set(authenticatedTargets)];
  }

  queueMessageSend(input: {
    platform: string;
    target: string;
    text: string;
    accountKey?: string;
  }): {
    queued: true;
    messageId: string;
  } {
    if (
      input.platform !== "signal" &&
      input.platform !== "whatsapp" &&
      input.platform !== "discord"
    ) {
      throw new Error(`Unsupported outbound platform: ${input.platform}`);
    }
    if (input.target.trim().length === 0 || input.text.trim().length === 0) {
      throw new Error(`${input.platform} send requires a target and non-empty text`);
    }

    const resolved =
      input.platform === "signal"
        ? this.db.resolveSignalSendTarget(input.target.trim())
        : input.platform === "whatsapp"
          ? this.db.resolveWhatsAppSendTarget(input.target.trim())
          : this.db.resolveDiscordSendTarget(input.target.trim());
    if (!resolved) {
      throw new Error(`Unable to resolve ${input.platform} target: ${input.target.trim()}`);
    }

    const messageId = this.db.queueOutboundMessage({
      platform: input.platform,
      accountKey: input.accountKey ?? getDefaultAccountKeyForPlatform(input.platform),
      target: resolved.target,
      threadId: resolved.threadId,
      text: input.text,
      metadata: {
        originalTarget: input.target.trim(),
        resolvedTarget: resolved.target,
        resolvedThreadId: resolved.threadId,
        resolution: resolved.resolution,
        matchedContactIds: "matchedContactIds" in resolved ? resolved.matchedContactIds : undefined,
        matchedConversationId:
          "matchedConversationId" in resolved ? resolved.matchedConversationId : undefined,
        matchedName: resolved.matchedName,
      },
    });
    this.schedulers.wakeOutbound?.();

    return {
      queued: true,
      messageId,
    };
  }

  queueSyncRun(source?: string): {
    queued: boolean;
    runId: string | null;
    runIds: string[];
    targets: string[];
  } {
    if (source === "whatsapp-desktop") {
      const accountKey = getDefaultAccountKeyForPlatform("whatsapp");
      if (this.db.hasQueuedOrRunningRun("whatsapp", accountKey)) {
        return {
          queued: false,
          runId: null,
          runIds: [],
          targets: ["whatsapp-desktop"],
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
      };
    }

    if (source && !isAdapterPlatform(source)) {
      throw new Error(`Unsupported sync source: ${source}`);
    }

    if (source && isAdapterPlatform(source)) {
      const targets = this.listManualSyncTargets(source);

      if (targets.length > 0) {
        const queuedTargets: string[] = [];
        const runInputs = targets.flatMap((targetKey) => {
          const parsedTarget = parseRunTargetKey(targetKey);
          if (!parsedTarget) {
            return [];
          }
          const { platform, accountKey } = parsedTarget;
          if (!platform || !accountKey || !isAdapterPlatform(platform)) {
            return [];
          }
          if (this.db.hasQueuedOrRunningRun(platform, accountKey)) {
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

        const runIds = this.db.queueSyncRuns(runInputs);
        if (runIds.length > 0) {
          this.schedulers.wakeIngest?.();
        }

        return {
          queued: runIds.length > 0,
          runId: runIds[0] ?? null,
          runIds,
          targets: queuedTargets,
        };
      }
    }

    const runId = this.db.queueSyncRun({
      platform: source && isAdapterPlatform(source) ? source : null,
      runType: "sync",
      trigger: "cli",
      details: { source: source ?? null },
    });
    this.schedulers.wakeIngest?.();

    return {
      queued: true,
      runId,
      runIds: [runId],
      targets: source ? [source] : [],
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
