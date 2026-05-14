import type { SyncMode, SyncProofInput } from "../../../core/types/provider.js";
import type { WhatsAppMessageSnapshot } from "../types.js";

export type WhatsAppResyncStats = {
  pageCount: number;
  contactCount: number;
  chatCount: number;
  messageCount: number;
  rawEventCount: number;
};

export type WhatsAppResyncCoverage = {
  oldestMessageAt: number | null;
  newestMessageAt: number | null;
};

export type WhatsAppDesktopCursor = {
  importedAt?: number;
  sourcePath?: string;
  chatRows?: number;
  contactRows?: number;
  messageRows?: number;
  oldestMessageAt?: number | null;
  newestMessageAt?: number | null;
};

export type WhatsAppSourceCursor = {
  lastSyncAt?: number;
  resyncCursor?: string | null;
  resyncSinceMs?: number | null;
  resyncStartedAt?: number;
  resyncSyncMode?: SyncMode;
  resyncStats?: WhatsAppResyncStats;
  resyncCoverage?: WhatsAppResyncCoverage;
  desktopDb?: WhatsAppDesktopCursor;
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStats(value: unknown): WhatsAppResyncStats | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    pageCount: numberOrZero(raw.pageCount),
    contactCount: numberOrZero(raw.contactCount),
    chatCount: numberOrZero(raw.chatCount),
    messageCount: numberOrZero(raw.messageCount),
    rawEventCount: numberOrZero(raw.rawEventCount),
  };
}

function parseCoverage(value: unknown): WhatsAppResyncCoverage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    oldestMessageAt: nullableNumber(raw.oldestMessageAt),
    newestMessageAt: nullableNumber(raw.newestMessageAt),
  };
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseDesktopCursor(value: unknown): WhatsAppDesktopCursor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const parsed: WhatsAppDesktopCursor = {
    importedAt: optionalPositiveNumber(raw.importedAt),
    sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
    chatRows: optionalPositiveNumber(raw.chatRows),
    contactRows: optionalPositiveNumber(raw.contactRows),
    messageRows: optionalPositiveNumber(raw.messageRows),
    oldestMessageAt: nullableNumber(raw.oldestMessageAt),
    newestMessageAt: nullableNumber(raw.newestMessageAt),
  };
  return Object.values(parsed).some((entry) => entry !== undefined) ? parsed : undefined;
}

export function parseWhatsAppSourceCursor(
  raw: Record<string, unknown> | null,
): WhatsAppSourceCursor {
  return {
    lastSyncAt: typeof raw?.lastSyncAt === "number" ? raw.lastSyncAt : undefined,
    resyncCursor: typeof raw?.resyncCursor === "string" ? raw.resyncCursor : null,
    resyncSinceMs:
      typeof raw?.resyncSinceMs === "number"
        ? raw.resyncSinceMs
        : raw?.resyncSinceMs === null
          ? null
          : undefined,
    resyncStartedAt: typeof raw?.resyncStartedAt === "number" ? raw.resyncStartedAt : undefined,
    resyncSyncMode:
      raw?.resyncSyncMode === "full" || raw?.resyncSyncMode === "incremental"
        ? raw.resyncSyncMode
        : undefined,
    resyncStats: parseStats(raw?.resyncStats),
    resyncCoverage: parseCoverage(raw?.resyncCoverage),
    desktopDb: parseDesktopCursor(raw?.desktopDb),
  };
}

export const DEFAULT_WHATSAPP_DESKTOP_HELPER_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

export function selectWhatsAppHelperSinceMs(input: {
  cursor: string | null;
  sourceCursor: WhatsAppSourceCursor;
  syncMode: SyncMode;
  checkpointLastSuccessAt?: number | null;
  desktopOverlapMs?: number;
}): number | null {
  if (input.cursor != null) {
    return input.sourceCursor.resyncSinceMs ?? null;
  }
  if (input.syncMode !== "incremental") {
    return null;
  }
  if (input.sourceCursor.lastSyncAt != null) {
    return input.sourceCursor.lastSyncAt;
  }
  const desktopNewestMessageAt = input.sourceCursor.desktopDb?.newestMessageAt;
  if (typeof desktopNewestMessageAt === "number" && Number.isFinite(desktopNewestMessageAt)) {
    const overlapMs = input.desktopOverlapMs ?? DEFAULT_WHATSAPP_DESKTOP_HELPER_OVERLAP_MS;
    return Math.max(0, desktopNewestMessageAt - Math.max(0, overlapMs));
  }
  return input.checkpointLastSuccessAt ?? null;
}

export function emptyWhatsAppResyncStats(): WhatsAppResyncStats {
  return {
    pageCount: 0,
    contactCount: 0,
    chatCount: 0,
    messageCount: 0,
    rawEventCount: 0,
  };
}

export function addWhatsAppResyncStats(
  left: WhatsAppResyncStats,
  right: WhatsAppResyncStats,
): WhatsAppResyncStats {
  return {
    pageCount: left.pageCount + right.pageCount,
    contactCount: left.contactCount + right.contactCount,
    chatCount: left.chatCount + right.chatCount,
    messageCount: left.messageCount + right.messageCount,
    rawEventCount: left.rawEventCount + right.rawEventCount,
  };
}

export function summarizeWhatsAppMessageCoverage(
  messages: WhatsAppMessageSnapshot[],
): WhatsAppResyncCoverage {
  let oldestMessageAt: number | null = null;
  let newestMessageAt: number | null = null;
  for (const message of messages) {
    if (!Number.isFinite(message.timestamp)) {
      continue;
    }
    oldestMessageAt =
      oldestMessageAt == null ? message.timestamp : Math.min(oldestMessageAt, message.timestamp);
    newestMessageAt =
      newestMessageAt == null ? message.timestamp : Math.max(newestMessageAt, message.timestamp);
  }
  return { oldestMessageAt, newestMessageAt };
}

export function mergeWhatsAppResyncCoverage(
  left: WhatsAppResyncCoverage,
  right: WhatsAppResyncCoverage,
): WhatsAppResyncCoverage {
  return {
    oldestMessageAt:
      left.oldestMessageAt == null
        ? right.oldestMessageAt
        : right.oldestMessageAt == null
          ? left.oldestMessageAt
          : Math.min(left.oldestMessageAt, right.oldestMessageAt),
    newestMessageAt:
      left.newestMessageAt == null
        ? right.newestMessageAt
        : right.newestMessageAt == null
          ? left.newestMessageAt
          : Math.max(left.newestMessageAt, right.newestMessageAt),
  };
}

export function buildWhatsAppMessagesProof(input: {
  accountKey: string;
  syncMode: SyncMode;
  observedAt: number;
  runStartedAt: number;
  hasMore: boolean;
  nextCursor: string | null;
  sinceMs: number | null;
  completedAt: number;
  stats: WhatsAppResyncStats;
  coverage: WhatsAppResyncCoverage;
}): SyncProofInput {
  return {
    scope: {
      kind: "account",
      key: input.accountKey,
      displayName: "WhatsApp",
      metadata: {
        source: "whatsmeow_history_cache",
      },
    },
    proofKind: "messages",
    status: input.hasMore ? "running" : "complete",
    syncMode: input.syncMode,
    observedAt: input.observedAt,
    runStartedAt: input.runStartedAt,
    completedAt: input.hasMore ? null : input.completedAt,
    resumeCursor: input.hasMore
      ? {
          cursor: input.nextCursor,
          sinceMs: input.sinceMs,
        }
      : null,
    coverage: {
      sinceMs: input.sinceMs,
      snapshotCompletedAt: input.completedAt,
      oldestMessageAt: input.coverage.oldestMessageAt,
      newestMessageAt: input.coverage.newestMessageAt,
    },
    stats: input.stats,
  };
}
