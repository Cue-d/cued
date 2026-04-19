import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CallDirection,
  CallMedium,
  CallProvider,
  CallStatus,
} from "../../core/types/provider.js";
import { normalizePhone, toE164 } from "../../core/utils/phone.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "./reader.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const APPLE_EPOCH_OFFSET = 978307200;

export const DEFAULT_CALL_HISTORY_DB_PATH = join(
  homedir(),
  "Library/Application Support/CallHistoryDB/CallHistory.storedata",
);

type CallHistoryRow = {
  pk: number;
  unique_id: string | null;
  date_value: number | null;
  duration_seconds: number | null;
  address: string | null;
  name: string | null;
  service_provider: string | null;
  call_type: number | null;
  originated: number | null;
  answered: number | null;
  disconnected_cause: number | null;
  handle_type: number | null;
  call_category: number | null;
};

export interface ImsCallRecord {
  pk: number;
  sourceCallKey: string;
  sourceConversationKey: string;
  remoteSourceKey: string | null;
  remoteAddress: string | null;
  remoteDisplayName: string | null;
  provider: CallProvider;
  providerCallType: string | null;
  direction: CallDirection;
  medium: CallMedium;
  status: CallStatus;
  startedAt: number;
  endedAt: number | null;
  durationSeconds: number | null;
  disconnectedCause: string | null;
  syntheticConversation: boolean;
}

export interface ImsCallSyncBatch {
  cursor: number;
  fetchedCount: number;
  calls: ImsCallRecord[];
}

function normalizeCallProvider(serviceProvider: string | null): CallProvider {
  const normalized = serviceProvider?.trim().toLowerCase() ?? "";
  if (normalized.includes("facetime")) return "facetime";
  if (normalized.includes("telephony")) return "telephony";
  return "unknown";
}

function normalizeCallMedium(provider: CallProvider, callType: number | null): CallMedium {
  if (callType === 8) return "video";
  if (callType === 16) return "audio";
  if (provider === "telephony") return "audio";
  return "unknown";
}

function normalizeCallDirection(originated: number | null): CallDirection {
  if (originated === 1) return "outgoing";
  if (originated === 0) return "incoming";
  return "unknown";
}

function isLikelyCompletedCall(answered: number | null, durationSeconds: number | null): boolean {
  if (answered === 1) {
    return true;
  }
  return typeof durationSeconds === "number" && durationSeconds >= 20;
}

function normalizeCallStatus(
  direction: CallDirection,
  disconnectedCause: number | null,
  answered: number | null,
  durationSeconds: number | null,
): CallStatus {
  if (isLikelyCompletedCall(answered, durationSeconds)) {
    return "completed";
  }
  if (disconnectedCause === 41) {
    return "failed";
  }
  if (direction === "incoming" && disconnectedCause === 21) {
    return "declined";
  }
  if (direction === "outgoing" && disconnectedCause === 12) {
    return "blocked";
  }
  if (direction === "outgoing") {
    return "canceled";
  }
  if (direction === "incoming") {
    return "missed";
  }
  return "unknown";
}

function buildRemoteSourceKey(address: string | null): string | null {
  const trimmed = address?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("@")) {
    return `imessage:${trimmed.toLowerCase()}`;
  }
  return `imessage:${toE164(trimmed) ?? normalizePhone(trimmed) ?? trimmed}`;
}

function buildHandleCandidates(address: string | null): string[] {
  const trimmed = address?.trim() ?? "";
  if (!trimmed) {
    return [];
  }
  if (trimmed.includes("@")) {
    return [trimmed.toLowerCase()];
  }

  const candidates = new Set<string>();
  const normalized = normalizePhone(trimmed);
  const e164 = toE164(trimmed);
  candidates.add(trimmed);
  if (normalized) {
    candidates.add(normalized);
    if (!normalized.startsWith("+")) {
      candidates.add(`+${normalized}`);
    }
    if (normalized.length === 10) {
      candidates.add(`+1${normalized}`);
    }
  }
  if (e164) {
    candidates.add(e164);
  }
  return [...candidates].filter((candidate) => candidate.length > 0);
}

export function loadCallHistoryBatch(options?: {
  path?: string;
  chatDbPath?: string;
  afterPk?: number;
  limit?: number;
}): ImsCallSyncBatch {
  const dbPath = options?.path ?? DEFAULT_CALL_HISTORY_DB_PATH;
  if (!existsSync(dbPath)) {
    return {
      cursor: options?.afterPk ?? 0,
      fetchedCount: 0,
      calls: [],
    };
  }

  const callDb = new DatabaseSync(dbPath, {
    open: true,
    readOnly: true,
  });
  const chatReader = new IMessageReader(options?.chatDbPath ?? DEFAULT_CHAT_DB_PATH);
  try {
    const rows = callDb
      .prepare(
        `
      SELECT
        Z_PK as pk,
        ZUNIQUE_ID as unique_id,
        ZDATE as date_value,
        ZDURATION as duration_seconds,
        ZADDRESS as address,
        ZNAME as name,
        ZSERVICE_PROVIDER as service_provider,
        ZCALLTYPE as call_type,
        ZORIGINATED as originated,
        ZANSWERED as answered,
        ZDISCONNECTED_CAUSE as disconnected_cause,
        ZHANDLE_TYPE as handle_type,
        ZCALL_CATEGORY as call_category
      FROM ZCALLRECORD
      WHERE Z_PK > ?
      ORDER BY Z_PK
      LIMIT ?
    `,
      )
      .all(options?.afterPk ?? 0, options?.limit ?? 500) as CallHistoryRow[];

    if (rows.length === 0) {
      return {
        cursor: options?.afterPk ?? 0,
        fetchedCount: 0,
        calls: [],
      };
    }

    const calls = rows.map((row) => {
      const remoteAddress = row.address?.trim() || null;
      const remoteSourceKey = buildRemoteSourceKey(remoteAddress);
      const conversationChatId = remoteAddress
        ? chatReader.findDirectChatIdByHandleCandidates(buildHandleCandidates(remoteAddress))
        : null;
      const sourceConversationKey =
        conversationChatId !== null
          ? String(conversationChatId)
          : remoteSourceKey
            ? `call:${remoteSourceKey}`
            : `call:${row.unique_id ?? row.pk}`;
      const provider = normalizeCallProvider(row.service_provider);
      const direction = normalizeCallDirection(row.originated);
      const durationSeconds =
        typeof row.duration_seconds === "number" && Number.isFinite(row.duration_seconds)
          ? Math.max(0, Math.round(row.duration_seconds))
          : null;
      const startedAt =
        typeof row.date_value === "number" && Number.isFinite(row.date_value)
          ? Math.round((row.date_value + APPLE_EPOCH_OFFSET) * 1000)
          : 0;
      const endedAt =
        typeof durationSeconds === "number" ? startedAt + durationSeconds * 1000 : null;
      return {
        pk: row.pk,
        sourceCallKey: row.unique_id?.trim() || `callhistory:${row.pk}`,
        sourceConversationKey,
        remoteSourceKey,
        remoteAddress,
        remoteDisplayName: row.name?.trim() || null,
        provider,
        providerCallType:
          typeof row.call_type === "number" && Number.isFinite(row.call_type)
            ? String(row.call_type)
            : null,
        direction,
        medium: normalizeCallMedium(provider, row.call_type),
        status: normalizeCallStatus(
          direction,
          row.disconnected_cause,
          row.answered,
          durationSeconds,
        ),
        startedAt,
        endedAt,
        durationSeconds,
        disconnectedCause:
          typeof row.disconnected_cause === "number" && Number.isFinite(row.disconnected_cause)
            ? String(row.disconnected_cause)
            : null,
        syntheticConversation: conversationChatId === null,
      } satisfies ImsCallRecord;
    });

    return {
      cursor: rows[rows.length - 1]?.pk ?? options?.afterPk ?? 0,
      fetchedCount: rows.length,
      calls,
    };
  } finally {
    chatReader.close();
    callDb.close();
  }
}
