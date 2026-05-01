import type { ProviderRawEventInput } from "../../../core/types/provider.js";
import { mapWithConcurrency } from "../../../core/utils/async.js";
import type { SyncBundle } from "../../core/sync.js";
import { GmailClient, type GmailHistoryMessageRef, type GmailMessage } from "../api/client.js";
import { buildGmailRawEvents } from "./events.js";

const DEFAULT_PAGE_SIZE = Number(process.env.CUED_GMAIL_PAGE_SIZE ?? "50");
const DEFAULT_PAGE_BUDGET = Number(process.env.CUED_GMAIL_PAGE_BUDGET ?? "5");
const DEFAULT_FETCH_CONCURRENCY = Number(process.env.CUED_GMAIL_FETCH_CONCURRENCY ?? "8");

export interface GmailSourceCursor {
  emailAddress?: string;
  historyId?: string | null;
  pageToken?: string | null;
  phase?: "historical" | "incremental";
  historicalSyncComplete?: boolean;
  listedMessageCount?: number;
  fetchedMessageCount?: number;
  pageCount?: number;
  startedAt?: number;
  lastSyncAt?: number;
  oldestMessageInternalDate?: number | null;
  newestMessageInternalDate?: number | null;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function parseCursor(raw: unknown): GmailSourceCursor {
  return raw && typeof raw === "object" ? (raw as GmailSourceCursor) : {};
}

function internalDate(message: GmailMessage): number | null {
  const parsed = Number(message.internalDate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function collectMessageDateBounds(
  messages: GmailMessage[],
  bounds: {
    oldestMessageInternalDate: number | null;
    newestMessageInternalDate: number | null;
  },
): { oldestMessageInternalDate: number | null; newestMessageInternalDate: number | null } {
  let { oldestMessageInternalDate, newestMessageInternalDate } = bounds;
  for (const message of messages) {
    const value = internalDate(message);
    if (value == null) continue;
    oldestMessageInternalDate =
      oldestMessageInternalDate == null ? value : Math.min(oldestMessageInternalDate, value);
    newestMessageInternalDate =
      newestMessageInternalDate == null ? value : Math.max(newestMessageInternalDate, value);
  }
  return { oldestMessageInternalDate, newestMessageInternalDate };
}

function extractAddedMessageRefs(history: Awaited<ReturnType<GmailClient["listHistory"]>>) {
  const refs = new Map<string, GmailHistoryMessageRef>();
  for (const record of history.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      refs.set(added.message.id, added.message);
    }
  }
  return [...refs.values()];
}

function dedupeRawEvents(rawEvents: ProviderRawEventInput[]): ProviderRawEventInput[] {
  return [...new Map(rawEvents.map((event) => [event.id, event])).values()];
}

export async function buildGmailSyncBundle(
  input: {
    accountKey?: string;
    sourceCursor?: unknown;
    pageBudget?: number;
    pageSize?: number;
    fetchConcurrency?: number;
  } = {},
): Promise<SyncBundle> {
  const accountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const cursor = parseCursor(input.sourceCursor);
  const pageBudget = positiveInt(input.pageBudget ?? DEFAULT_PAGE_BUDGET, 5);
  const pageSize = positiveInt(input.pageSize ?? DEFAULT_PAGE_SIZE, 50);
  const fetchConcurrency = positiveInt(input.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY, 8);
  const observedAt = Date.now();
  const startedAt = cursor.startedAt ?? observedAt;
  const client = GmailClient.fromKeychain(accountKey);
  const profile = await client.getProfile();
  const emailAddress = profile.emailAddress;
  const hasCompletedHistoricalSync =
    cursor.historicalSyncComplete === true && cursor.phase === "incremental";
  if (hasCompletedHistoricalSync) {
    const startHistoryId = cursor.historyId ?? profile.historyId;
    if (!startHistoryId) {
      throw new Error("Gmail incremental sync is missing a start historyId");
    }
    let pageToken = cursor.pageToken ?? null;
    let hasMore = false;
    let listedMessageCount = cursor.listedMessageCount ?? 0;
    let fetchedMessageCount = cursor.fetchedMessageCount ?? 0;
    let pageCount = cursor.pageCount ?? 0;
    let oldestMessageInternalDate = cursor.oldestMessageInternalDate ?? null;
    let newestMessageInternalDate = cursor.newestMessageInternalDate ?? null;
    let latestHistoryId = profile.historyId ?? startHistoryId;
    const messages: GmailMessage[] = [];

    for (let pageIndex = 0; pageIndex < pageBudget; pageIndex += 1) {
      const page = await client.listHistory({
        startHistoryId,
        pageToken,
        maxResults: pageSize,
      });
      latestHistoryId = page.historyId ?? latestHistoryId;
      const ids = extractAddedMessageRefs(page);
      listedMessageCount += ids.length;
      pageCount += 1;
      const fetched = await mapWithConcurrency(ids, fetchConcurrency, async (entry) =>
        client.getMessage(entry.id),
      );
      fetchedMessageCount += fetched.length;
      messages.push(...fetched);
      const bounds = collectMessageDateBounds(fetched, {
        oldestMessageInternalDate,
        newestMessageInternalDate,
      });
      oldestMessageInternalDate = bounds.oldestMessageInternalDate;
      newestMessageInternalDate = bounds.newestMessageInternalDate;
      pageToken = page.nextPageToken ?? null;
      hasMore = Boolean(pageToken);
      if (!hasMore) break;
    }

    const rawEvents = dedupeRawEvents(
      buildGmailRawEvents({
        accountKey,
        emailAddress,
        messages,
        observedAt,
      }),
    );
    const sourceCursor: GmailSourceCursor = {
      ...cursor,
      emailAddress,
      historyId: hasMore ? startHistoryId : latestHistoryId,
      pageToken,
      phase: "incremental",
      historicalSyncComplete: true,
      listedMessageCount,
      fetchedMessageCount,
      pageCount,
      lastSyncAt: hasMore ? cursor.lastSyncAt : observedAt,
      oldestMessageInternalDate,
      newestMessageInternalDate,
    };
    return {
      sourceAccounts: [{ platform: "gmail", accountKey, displayName: emailAddress }],
      rawEvents,
      sourceCursor,
      syncMode: "incremental",
      hasMore,
      proofs: [
        {
          scope: {
            kind: "account",
            key: "all_mail_except_spam_trash",
            displayName: "All Gmail mail except spam and trash",
            metadata: { emailAddress },
          },
          proofKind: "messages",
          status: hasMore ? "running" : "complete",
          syncMode: "incremental",
          observedAt,
          runStartedAt: cursor.startedAt ?? observedAt,
          completedAt: hasMore ? null : observedAt,
          resumeCursor: hasMore ? sourceCursor : null,
          coverage: {
            emailAddress,
            historyId: hasMore ? startHistoryId : latestHistoryId,
            historicalSyncComplete: true,
            oldestMessageInternalDate,
            newestMessageInternalDate,
          },
          stats: {
            listedMessageCount,
            fetchedMessageCount,
            rawEventCount: rawEvents.length,
            pageCount,
            pageSize,
            fetchConcurrency,
            messagesTotal: profile.messagesTotal ?? null,
            threadsTotal: profile.threadsTotal ?? null,
          },
        },
      ],
    };
  }

  let pageToken = cursor.pageToken ?? null;
  let hasMore = false;
  let listedMessageCount = cursor.listedMessageCount ?? 0;
  let fetchedMessageCount = cursor.fetchedMessageCount ?? 0;
  let pageCount = cursor.pageCount ?? 0;
  let oldestMessageInternalDate = cursor.oldestMessageInternalDate ?? null;
  let newestMessageInternalDate = cursor.newestMessageInternalDate ?? null;
  const messages: GmailMessage[] = [];

  for (let pageIndex = 0; pageIndex < pageBudget; pageIndex += 1) {
    const page = await client.listMessages({ pageToken, maxResults: pageSize });
    const ids = page.messages ?? [];
    listedMessageCount += ids.length;
    pageCount += 1;
    const fetched = await mapWithConcurrency(ids, fetchConcurrency, async (entry) =>
      client.getMessage(entry.id),
    );
    fetchedMessageCount += fetched.length;
    messages.push(...fetched);
    const bounds = collectMessageDateBounds(fetched, {
      oldestMessageInternalDate,
      newestMessageInternalDate,
    });
    oldestMessageInternalDate = bounds.oldestMessageInternalDate;
    newestMessageInternalDate = bounds.newestMessageInternalDate;
    pageToken = page.nextPageToken ?? null;
    hasMore = Boolean(pageToken);
    if (!hasMore) break;
  }

  const rawEvents = dedupeRawEvents(
    buildGmailRawEvents({
      accountKey,
      emailAddress,
      messages,
      observedAt,
    }),
  );
  const historicalSyncComplete = !hasMore;
  const sourceCursor: GmailSourceCursor | null = hasMore
    ? {
        emailAddress,
        historyId: profile.historyId ?? cursor.historyId ?? null,
        pageToken,
        phase: "historical",
        historicalSyncComplete: false,
        listedMessageCount,
        fetchedMessageCount,
        pageCount,
        startedAt,
        oldestMessageInternalDate,
        newestMessageInternalDate,
      }
    : {
        emailAddress,
        historyId: profile.historyId ?? cursor.historyId ?? null,
        pageToken: null,
        phase: "incremental",
        historicalSyncComplete: true,
        listedMessageCount,
        fetchedMessageCount,
        pageCount,
        startedAt,
        lastSyncAt: observedAt,
        oldestMessageInternalDate,
        newestMessageInternalDate,
      };

  return {
    sourceAccounts: [{ platform: "gmail", accountKey, displayName: emailAddress }],
    rawEvents,
    sourceCursor,
    syncMode: historicalSyncComplete ? "full" : "full",
    hasMore,
    proofs: [
      {
        scope: {
          kind: "account",
          key: "all_mail_except_spam_trash",
          displayName: "All Gmail mail except spam and trash",
          metadata: { emailAddress },
        },
        proofKind: "messages",
        status: historicalSyncComplete ? "complete" : "running",
        syncMode: "full",
        observedAt,
        runStartedAt: startedAt,
        completedAt: historicalSyncComplete ? observedAt : null,
        resumeCursor: hasMore ? sourceCursor : null,
        coverage: {
          emailAddress,
          historyId: profile.historyId ?? null,
          historicalSyncComplete,
          oldestMessageInternalDate,
          newestMessageInternalDate,
        },
        stats: {
          listedMessageCount,
          fetchedMessageCount,
          rawEventCount: rawEvents.length,
          pageCount,
          pageSize,
          fetchConcurrency,
          messagesTotal: profile.messagesTotal ?? null,
          threadsTotal: profile.threadsTotal ?? null,
        },
      },
    ],
  };
}
