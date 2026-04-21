import type { SourceAccountInput } from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import { SlackHelperClient } from "../helper/client.js";
import type { SlackTransport } from "../transport.js";
import type { SlackConversation, SlackCredentials, SlackMessage, SlackUser } from "../types.js";
import {
  buildSlackContactEvents,
  buildSlackConversationEvent,
  buildSlackMessageEvents,
  slackTimestampMs,
} from "./events.js";
import {
  buildSlackBackfillSyncProofs,
  type SlackBackfillConversationPhase,
  type SlackBackfillConversationProof,
} from "./proof.js";

const INCREMENTAL_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_SLACK_CONVERSATIONS_PER_RUN = 5;
const DEFAULT_SLACK_MESSAGES_PAGE_LIMIT = 100;
const DEFAULT_SLACK_REPLIES_PAGE_LIMIT = 50;
const DEFAULT_SLACK_CHANNEL_HISTORY_DAYS = 0;
const DEFAULT_SLACK_API_PAGES_PER_RUN = 25;

type SlackScanMode = "full" | "incremental";
type SlackConversationFamily = "direct" | "channels";

const SLACK_FULL_SCAN_FAMILIES: SlackConversationFamily[] = ["direct", "channels"];
const SLACK_CONVERSATION_TYPES: Record<SlackConversationFamily, string> = {
  direct: "im,mpim",
  channels: "public_channel,private_channel",
};

export interface SlackScanCursor {
  mode: SlackScanMode;
  startedAt: number;
  oldestMs: number;
  usersComplete: boolean;
  conversationFamily?: SlackConversationFamily;
  conversationCursor?: string | null;
  conversationIndex?: number;
  activeConversationId?: string;
  historyCursor?: string | null;
  historyComplete?: boolean;
  conversationPhase?: SlackBackfillConversationPhase;
  threadRootCount?: number;
  completedThreadCount?: number;
  pendingThreadTs?: string[];
  activeThreadTs?: string | null;
  repliesCursor?: string | null;
}

export interface SlackSourceCursor {
  teamId: string;
  selfUserId: string;
  lastSyncAt?: number;
  knownConversationIds?: string[];
  scan?: SlackScanCursor;
}

function now(): number {
  return Date.now();
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function formatOldestTs(oldestMs: number): string | undefined {
  if (!Number.isFinite(oldestMs) || oldestMs <= 0) {
    return undefined;
  }
  return (oldestMs / 1000).toFixed(6);
}

function getOldestMessageMs(mode: SlackScanMode, lastSyncAt?: number): number {
  if (mode === "incremental" && lastSyncAt && lastSyncAt > 0) {
    return Math.max(0, lastSyncAt - INCREMENTAL_BUFFER_MS);
  }
  return 0;
}

function isDirectConversation(conversation: SlackConversation): boolean {
  return Boolean(conversation.is_im || conversation.is_mpim);
}

function compareConversationPriority(left: SlackConversation, right: SlackConversation): number {
  const leftDirect = isDirectConversation(left) ? 0 : 1;
  const rightDirect = isDirectConversation(right) ? 0 : 1;
  if (leftDirect !== rightDirect) {
    return leftDirect - rightDirect;
  }

  const leftMembers =
    typeof left.num_members === "number" ? left.num_members : Number.MAX_SAFE_INTEGER;
  const rightMembers =
    typeof right.num_members === "number" ? right.num_members : Number.MAX_SAFE_INTEGER;
  if (leftMembers !== rightMembers) {
    return leftMembers - rightMembers;
  }

  return left.id.localeCompare(right.id);
}

function getConversationHistoryOldestMs(
  mode: SlackScanMode,
  oldestMs: number,
  conversation: SlackConversation,
  observedAt: number,
): number {
  if (mode === "incremental") {
    return oldestMs;
  }

  if (isDirectConversation(conversation)) {
    return oldestMs;
  }

  const historyDays = DEFAULT_SLACK_CHANNEL_HISTORY_DAYS;
  if (historyDays <= 0) {
    return oldestMs;
  }

  const boundedWindowMs = historyDays * 24 * 60 * 60 * 1000;
  return Math.max(oldestMs, observedAt - boundedWindowMs);
}

function isSlackConversationFamily(value: unknown): value is SlackConversationFamily {
  return value === "direct" || value === "channels";
}

function inferConversationFamily(
  conversationCursor: string | null | undefined,
): SlackConversationFamily {
  if (typeof conversationCursor === "string" && conversationCursor.startsWith("im_")) {
    return "direct";
  }
  return "channels";
}

function nextConversationFamily(
  family: SlackConversationFamily,
): SlackConversationFamily | undefined {
  const index = SLACK_FULL_SCAN_FAMILIES.indexOf(family);
  return index >= 0 ? SLACK_FULL_SCAN_FAMILIES[index + 1] : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function shouldIncludeMessage(message: SlackMessage): boolean {
  if (message.subtype === "channel_join" || message.subtype === "channel_leave") {
    return false;
  }
  return Boolean(
    message.text ||
      (message.files && message.files.length > 0) ||
      (message.attachments && message.attachments.length > 0),
  );
}

function shouldFetchConversationIncrementally(
  conversation: SlackConversation,
  oldestMs: number,
): boolean {
  const latestMs = slackTimestampMs(conversation.latest?.ts);
  return latestMs == null || latestMs >= oldestMs;
}

function sortSlackMessages(messages: SlackMessage[]): SlackMessage[] {
  return [...messages].sort((left, right) => {
    const leftTs = Number(left.ts);
    const rightTs = Number(right.ts);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs)) {
      return leftTs - rightTs;
    }
    return left.ts.localeCompare(right.ts);
  });
}

function loadSlackAuthFromKeychain(accountKey: string): SlackCredentials {
  const parsed = loadIntegrationSecret("slack", accountKey).secret;
  if (typeof parsed.token !== "string" || typeof parsed.cookie !== "string") {
    throw new Error(`Slack Keychain payload for '${accountKey}' is missing token or cookie`);
  }
  return {
    token: parsed.token,
    cookie: parsed.cookie,
  };
}

function parseSlackSourceCursor(raw: unknown): SlackSourceCursor | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const lastSyncAt = typeof value.lastSyncAt === "number" ? value.lastSyncAt : undefined;
  const teamId = typeof value.teamId === "string" ? value.teamId : "";
  const selfUserId = typeof value.selfUserId === "string" ? value.selfUserId : "";
  const knownConversationIds = parseStringArray(value.knownConversationIds);
  const rawScan = value.scan;
  const scan =
    rawScan && typeof rawScan === "object"
      ? (() => {
          const parsed = rawScan as Record<string, unknown>;
          const mode =
            parsed.mode === "incremental" ? "incremental" : parsed.mode === "full" ? "full" : null;
          const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : null;
          const oldestMs = typeof parsed.oldestMs === "number" ? parsed.oldestMs : null;
          if (!mode || startedAt == null || oldestMs == null) {
            return undefined;
          }
          return {
            mode,
            startedAt,
            oldestMs,
            usersComplete: parsed.usersComplete === true,
            conversationFamily: isSlackConversationFamily(parsed.conversationFamily)
              ? parsed.conversationFamily
              : inferConversationFamily(
                  typeof parsed.conversationCursor === "string" ||
                    parsed.conversationCursor === null
                    ? parsed.conversationCursor
                    : undefined,
                ),
            conversationCursor:
              typeof parsed.conversationCursor === "string" || parsed.conversationCursor === null
                ? parsed.conversationCursor
                : undefined,
            conversationIndex:
              typeof parsed.conversationIndex === "number" && parsed.conversationIndex >= 0
                ? Math.trunc(parsed.conversationIndex)
                : undefined,
            activeConversationId:
              typeof parsed.activeConversationId === "string"
                ? parsed.activeConversationId
                : undefined,
            historyCursor:
              typeof parsed.historyCursor === "string" || parsed.historyCursor === null
                ? parsed.historyCursor
                : undefined,
            historyComplete: parsed.historyComplete === true,
            conversationPhase:
              parsed.conversationPhase === "history" ||
              parsed.conversationPhase === "threads" ||
              parsed.conversationPhase === "complete"
                ? parsed.conversationPhase
                : undefined,
            threadRootCount:
              typeof parsed.threadRootCount === "number" && parsed.threadRootCount >= 0
                ? Math.trunc(parsed.threadRootCount)
                : undefined,
            completedThreadCount:
              typeof parsed.completedThreadCount === "number" && parsed.completedThreadCount >= 0
                ? Math.trunc(parsed.completedThreadCount)
                : undefined,
            pendingThreadTs: parseStringArray(parsed.pendingThreadTs),
            activeThreadTs:
              typeof parsed.activeThreadTs === "string" || parsed.activeThreadTs === null
                ? parsed.activeThreadTs
                : undefined,
            repliesCursor:
              typeof parsed.repliesCursor === "string" || parsed.repliesCursor === null
                ? parsed.repliesCursor
                : undefined,
          } satisfies SlackScanCursor;
        })()
      : undefined;

  if (!teamId || !selfUserId) {
    if (lastSyncAt == null && !scan) {
      return undefined;
    }
    return {
      teamId,
      selfUserId,
      lastSyncAt,
      knownConversationIds,
      scan,
    };
  }

  return {
    teamId,
    selfUserId,
    lastSyncAt,
    knownConversationIds,
    scan,
  };
}

async function listAllUsers(client: SlackTransport): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listUsers(cursor);
    users.push(...result.users.filter((user) => !user.deleted));
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return users;
}

async function listConversationMembers(
  client: SlackTransport,
  conversation: SlackConversation,
): Promise<string[]> {
  if (conversation.is_im && conversation.user) {
    return [conversation.user];
  }

  if (!conversation.is_mpim) {
    return [];
  }

  const members: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.getConversationMembers(conversation.id, cursor);
    members.push(...result.members);
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return [...new Set(members)];
}

async function listConversationMessages(
  client: SlackTransport,
  conversationId: string,
  oldestMs: number,
  messagesPageLimit: number,
  repliesPageLimit: number,
): Promise<SlackMessage[]> {
  const messageByTs = new Map<string, SlackMessage>();
  const threadParents = new Set<string>();
  const oldest = formatOldestTs(oldestMs);
  let cursor: string | undefined;

  do {
    const result = await client.getHistory(conversationId, {
      cursor,
      oldest,
      limit: messagesPageLimit,
    });

    for (const message of result.messages) {
      if (message.reply_count && message.reply_count > 0) {
        threadParents.add(message.ts);
      }
      if (!shouldIncludeMessage(message)) {
        continue;
      }
      messageByTs.set(message.ts, message);
    }

    cursor = result.nextCursor || undefined;
  } while (cursor);

  for (const threadTs of threadParents) {
    let repliesCursor: string | undefined;
    do {
      const result = await client.getReplies(conversationId, threadTs, {
        cursor: repliesCursor,
        oldest,
        limit: repliesPageLimit,
      });

      for (const reply of result.messages) {
        if (reply.ts === threadTs || !shouldIncludeMessage(reply)) {
          continue;
        }
        messageByTs.set(reply.ts, reply);
      }

      repliesCursor = result.nextCursor || undefined;
    } while (repliesCursor);
  }

  return sortSlackMessages(Array.from(messageByTs.values()));
}

interface SlackConversationResumeState {
  historyCursor: string | null;
  historyComplete: boolean;
  conversationPhase: SlackBackfillConversationPhase;
  threadRootCount: number;
  completedThreadCount: number;
  pendingThreadTs: string[];
  activeThreadTs: string | null;
  repliesCursor: string | null;
}

interface SlackConversationBatchResult {
  messages: SlackMessage[];
  complete: boolean;
  resumeState: SlackConversationResumeState;
}

async function listConversationMessagesBatch(
  client: SlackTransport,
  conversationId: string,
  oldestMs: number,
  messagesPageLimit: number,
  repliesPageLimit: number,
  resumeState?: Partial<SlackConversationResumeState>,
  apiPageBudget: number = DEFAULT_SLACK_API_PAGES_PER_RUN,
): Promise<SlackConversationBatchResult> {
  const oldest = formatOldestTs(oldestMs);
  const messages: SlackMessage[] = [];
  const seenMessageTs = new Set<string>();
  const pendingThreadTs = [...(resumeState?.pendingThreadTs ?? [])];
  let historyCursor = resumeState?.historyCursor ?? null;
  let historyComplete = resumeState?.historyComplete ?? false;
  let threadRootCount = Math.max(
    resumeState?.threadRootCount ?? 0,
    pendingThreadTs.length + (resumeState?.activeThreadTs ? 1 : 0),
  );
  let completedThreadCount = Math.max(resumeState?.completedThreadCount ?? 0, 0);
  let activeThreadTs = resumeState?.activeThreadTs ?? null;
  let repliesCursor = resumeState?.repliesCursor ?? null;
  let apiPagesRemaining = apiPageBudget;

  const addMessage = (message: SlackMessage) => {
    if (!shouldIncludeMessage(message) || seenMessageTs.has(message.ts)) {
      return;
    }
    seenMessageTs.add(message.ts);
    messages.push(message);
  };

  while (apiPagesRemaining > 0) {
    if (!historyComplete) {
      const result = await client.getHistory(conversationId, {
        cursor: historyCursor ?? undefined,
        oldest,
        limit: messagesPageLimit,
      });
      apiPagesRemaining -= 1;
      for (const message of result.messages) {
        if (message.reply_count && message.reply_count > 0) {
          pendingThreadTs.push(message.ts);
          threadRootCount += 1;
        }
        addMessage(message);
      }
      historyCursor = result.nextCursor ?? null;
      if (!historyCursor) {
        historyComplete = true;
      }
      continue;
    }

    if (!activeThreadTs && pendingThreadTs.length > 0) {
      activeThreadTs = pendingThreadTs.shift() ?? null;
      repliesCursor = null;
    }

    if (activeThreadTs) {
      const result = await client.getReplies(conversationId, activeThreadTs, {
        cursor: repliesCursor ?? undefined,
        oldest,
        limit: repliesPageLimit,
      });
      apiPagesRemaining -= 1;
      for (const reply of result.messages) {
        if (reply.ts === activeThreadTs) {
          continue;
        }
        addMessage(reply);
      }
      repliesCursor = result.nextCursor ?? null;
      if (!repliesCursor) {
        completedThreadCount += 1;
        activeThreadTs = null;
      }
      continue;
    }

    break;
  }

  const conversationPhase: SlackBackfillConversationPhase = !historyComplete
    ? "history"
    : activeThreadTs || pendingThreadTs.length > 0
      ? "threads"
      : "complete";

  return {
    messages: sortSlackMessages(messages),
    complete: historyComplete && !activeThreadTs && pendingThreadTs.length === 0,
    resumeState: {
      historyCursor,
      historyComplete,
      conversationPhase,
      threadRootCount,
      completedThreadCount,
      pendingThreadTs,
      activeThreadTs,
      repliesCursor: activeThreadTs ? repliesCursor : null,
    },
  };
}

function summarizeMessageRange(messages: SlackMessage[]): {
  oldest: string | null;
  newest: string | null;
} {
  if (messages.length === 0) {
    return { oldest: null, newest: null };
  }
  const sorted = sortSlackMessages(messages);
  return {
    oldest: sorted[0]?.ts ?? null,
    newest: sorted.at(-1)?.ts ?? null,
  };
}

function buildSlackBackfillConversationProof(input: {
  teamId: string;
  accountKey: string;
  conversation: SlackConversation;
  family: SlackConversationFamily;
  scan: SlackScanCursor;
  knownConversationCount: number;
  observedAt: number;
  messageBatch: SlackConversationBatchResult;
}): SlackBackfillConversationProof {
  const range = summarizeMessageRange(input.messageBatch.messages);
  return {
    teamId: input.teamId,
    accountKey: input.accountKey,
    syncMode: input.scan.mode,
    scanStartedAt: input.scan.startedAt,
    knownConversationCount: input.knownConversationCount,
    conversationId: input.conversation.id,
    conversationName: input.conversation.name,
    conversationFamily: input.family,
    conversationPhase: input.messageBatch.resumeState.conversationPhase,
    historyComplete: input.messageBatch.resumeState.historyComplete,
    historyCursor: input.messageBatch.resumeState.historyCursor,
    threadRootCount: input.messageBatch.resumeState.threadRootCount,
    completedThreadCount: input.messageBatch.resumeState.completedThreadCount,
    pendingThreadCount:
      input.messageBatch.resumeState.pendingThreadTs.length +
      (input.messageBatch.resumeState.activeThreadTs ? 1 : 0),
    activeThreadTs: input.messageBatch.resumeState.activeThreadTs,
    repliesCursor: input.messageBatch.resumeState.repliesCursor,
    oldestMessageTs: range.oldest,
    newestMessageTs: range.newest,
    observedAt: input.observedAt,
  };
}

function buildCompleteSlackBackfillConversationProof(input: {
  teamId: string;
  accountKey: string;
  conversation: SlackConversation;
  family: SlackConversationFamily;
  scanMode: SlackScanMode;
  scanStartedAt: number;
  knownConversationCount: number;
  observedAt: number;
  messages: SlackMessage[];
}): SlackBackfillConversationProof {
  const range = summarizeMessageRange(input.messages);
  const threadRootCount = input.messages.filter(
    (message) => Number(message.reply_count ?? 0) > 0,
  ).length;
  return {
    teamId: input.teamId,
    accountKey: input.accountKey,
    syncMode: input.scanMode,
    scanStartedAt: input.scanStartedAt,
    knownConversationCount: input.knownConversationCount,
    conversationId: input.conversation.id,
    conversationName: input.conversation.name,
    conversationFamily: input.family,
    conversationPhase: "complete",
    historyComplete: true,
    historyCursor: null,
    threadRootCount,
    completedThreadCount: threadRootCount,
    pendingThreadCount: 0,
    activeThreadTs: null,
    repliesCursor: null,
    oldestMessageTs: range.oldest,
    newestMessageTs: range.newest,
    observedAt: input.observedAt,
  };
}

export async function buildSlackSyncBundle(options?: {
  accountKey?: string;
  lastSyncAt?: number;
  sourceCursor?: unknown;
  client?: SlackTransport;
  conversationPageLimit?: number;
  messagesPageLimit?: number;
  apiPageBudget?: number;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const loadedAuth = options?.client ? null : loadSlackAuthFromKeychain(accountKey);
  const client = options?.client ?? new SlackHelperClient(loadedAuth!);
  const savedCursor = parseSlackSourceCursor(options?.sourceCursor);
  const previousLastSyncAt =
    typeof options?.lastSyncAt === "number" ? options.lastSyncAt : savedCursor?.lastSyncAt;

  const auth = await client.testAuth();
  if (!auth.ok || !auth.team_id || !auth.user_id) {
    throw new Error(`Slack auth test failed for '${accountKey}': ${auth.error ?? "unknown_error"}`);
  }

  const teamId = auth.team_id;
  const teamName = auth.team ?? teamId;
  const selfUserId = auth.user_id;
  const observedBase = now();
  const conversationPageLimit = positiveInt(
    options?.conversationPageLimit ?? DEFAULT_SLACK_CONVERSATIONS_PER_RUN,
    25,
  );
  const messagesPageLimit = positiveInt(
    options?.messagesPageLimit ?? DEFAULT_SLACK_MESSAGES_PAGE_LIMIT,
    100,
  );
  const repliesPageLimit = Math.min(
    messagesPageLimit,
    positiveInt(DEFAULT_SLACK_REPLIES_PAGE_LIMIT, DEFAULT_SLACK_MESSAGES_PAGE_LIMIT),
  );
  const apiPageBudget = positiveInt(options?.apiPageBudget ?? DEFAULT_SLACK_API_PAGES_PER_RUN, 25);

  const mode: SlackScanMode = previousLastSyncAt && previousLastSyncAt > 0 ? "incremental" : "full";
  const scan: SlackScanCursor = savedCursor?.scan ?? {
    mode,
    startedAt: observedBase,
    oldestMs: getOldestMessageMs(mode, previousLastSyncAt),
    usersComplete: Boolean(previousLastSyncAt && previousLastSyncAt > 0),
    conversationFamily: "direct",
    conversationCursor: null,
  };

  const sourceAccounts: SourceAccountInput[] = [
    {
      platform: "slack",
      accountKey,
      displayName: teamName,
    },
  ];
  const rawEvents: SyncBundle["rawEvents"] = [];
  const slackBackfillDiagnostics: SlackBackfillConversationProof[] = [];
  const usersById = new Map<string, SlackUser>();
  const knownConversationIds = new Set(savedCursor?.knownConversationIds ?? []);

  if (scan.mode === "full" && !scan.usersComplete) {
    const users = await listAllUsers(client);
    rawEvents.push(...buildSlackContactEvents(teamId, accountKey, observedBase, users));
    for (const user of users) {
      usersById.set(user.id, user);
    }
    scan.usersComplete = true;
  }

  const conversationPages =
    scan.mode === "incremental"
      ? await Promise.all(
          SLACK_FULL_SCAN_FAMILIES.map(async (family) => ({
            family,
            page: await client.listConversations(
              SLACK_CONVERSATION_TYPES[family],
              undefined,
              conversationPageLimit,
            ),
          })),
        )
      : [
          {
            family: scan.conversationFamily ?? "direct",
            page: await client.listConversations(
              SLACK_CONVERSATION_TYPES[scan.conversationFamily ?? "direct"],
              scan.conversationCursor ?? undefined,
              conversationPageLimit,
            ),
          },
        ];

  for (const { page, family } of conversationPages) {
    const orderedConversations = [...page.conversations].sort(compareConversationPriority);
    if (scan.mode === "full") {
      if (orderedConversations.length === 0) {
        continue;
      }

      let conversationIndex = Math.max(0, scan.conversationIndex ?? 0);
      if (scan.activeConversationId) {
        const activeIndex = orderedConversations.findIndex(
          (conversation) => conversation.id === scan.activeConversationId,
        );
        if (activeIndex >= 0) {
          conversationIndex = activeIndex;
        }
      }

      if (conversationIndex >= orderedConversations.length) {
        conversationIndex = orderedConversations.length - 1;
      }

      const conversation = orderedConversations[conversationIndex];
      const conversationOldestMs = getConversationHistoryOldestMs(
        scan.mode,
        scan.oldestMs,
        conversation,
        observedBase,
      );
      const memberIds = await listConversationMembers(client, conversation);
      const messageBatch = await listConversationMessagesBatch(
        client,
        conversation.id,
        conversationOldestMs,
        messagesPageLimit,
        repliesPageLimit,
        scan.activeConversationId === conversation.id
          ? {
              historyCursor: scan.historyCursor ?? null,
              historyComplete: scan.historyComplete === true,
              threadRootCount: scan.threadRootCount ?? 0,
              completedThreadCount: scan.completedThreadCount ?? 0,
              pendingThreadTs: scan.pendingThreadTs ?? [],
              activeThreadTs: scan.activeThreadTs ?? null,
              repliesCursor: scan.repliesCursor ?? null,
            }
          : undefined,
        apiPageBudget,
      );
      knownConversationIds.add(conversation.id);
      slackBackfillDiagnostics.push(
        buildSlackBackfillConversationProof({
          teamId,
          accountKey,
          conversation,
          family,
          scan,
          knownConversationCount: knownConversationIds.size,
          observedAt: observedBase,
          messageBatch,
        }),
      );
      rawEvents.push(
        buildSlackConversationEvent({
          teamId,
          accountKey,
          conversation,
          observedAt: observedBase,
          memberIds,
          selfUserId,
          usersById,
        }),
      );

      rawEvents.push(
        ...buildSlackMessageEvents({
          teamId,
          accountKey,
          conversationId: conversation.id,
          selfUserId,
          observedAt: observedBase,
          messages: messageBatch.messages,
        }),
      );

      let sourceCursor: SlackSourceCursor;
      let hasMore = false;
      const nextCursor = page.conversations.length > 0 ? page.nextCursor || null : null;
      const nextFamily = nextConversationFamily(family);

      if (!messageBatch.complete) {
        hasMore = true;
        sourceCursor = {
          teamId,
          selfUserId,
          lastSyncAt: previousLastSyncAt,
          knownConversationIds: Array.from(knownConversationIds).sort(),
          scan: {
            ...scan,
            usersComplete: scan.usersComplete,
            conversationFamily: family,
            conversationCursor: scan.conversationCursor ?? null,
            conversationIndex,
            activeConversationId: conversation.id,
            historyCursor: messageBatch.resumeState.historyCursor,
            historyComplete: messageBatch.resumeState.historyComplete,
            conversationPhase: messageBatch.resumeState.conversationPhase,
            threadRootCount: messageBatch.resumeState.threadRootCount,
            completedThreadCount: messageBatch.resumeState.completedThreadCount,
            pendingThreadTs: messageBatch.resumeState.pendingThreadTs,
            activeThreadTs: messageBatch.resumeState.activeThreadTs,
            repliesCursor: messageBatch.resumeState.repliesCursor,
          },
        };
      } else if (conversationIndex + 1 < orderedConversations.length) {
        hasMore = true;
        sourceCursor = {
          teamId,
          selfUserId,
          lastSyncAt: previousLastSyncAt,
          knownConversationIds: Array.from(knownConversationIds).sort(),
          scan: {
            ...scan,
            usersComplete: scan.usersComplete,
            conversationFamily: family,
            conversationCursor: scan.conversationCursor ?? null,
            conversationIndex: conversationIndex + 1,
            activeConversationId: undefined,
            historyCursor: undefined,
            historyComplete: undefined,
            conversationPhase: undefined,
            threadRootCount: undefined,
            completedThreadCount: undefined,
            pendingThreadTs: undefined,
            activeThreadTs: undefined,
            repliesCursor: undefined,
          },
        };
      } else {
        const nextScanFamily = nextCursor != null ? family : nextFamily;
        if (nextScanFamily) {
          hasMore = true;
          sourceCursor = {
            teamId,
            selfUserId,
            lastSyncAt: previousLastSyncAt,
            knownConversationIds: Array.from(knownConversationIds).sort(),
            scan: {
              ...scan,
              usersComplete: scan.usersComplete,
              conversationFamily: nextScanFamily,
              conversationCursor: nextCursor != null ? nextCursor : null,
              conversationIndex: undefined,
              activeConversationId: undefined,
              historyCursor: undefined,
              historyComplete: undefined,
              conversationPhase: undefined,
              threadRootCount: undefined,
              completedThreadCount: undefined,
              pendingThreadTs: undefined,
              activeThreadTs: undefined,
              repliesCursor: undefined,
            },
          };
        } else {
          sourceCursor = {
            teamId,
            selfUserId,
            lastSyncAt: scan.startedAt,
            knownConversationIds: Array.from(knownConversationIds).sort(),
          };
        }
      }

      return {
        sourceAccounts,
        rawEvents,
        sourceCursor,
        syncMode: scan.mode,
        hasMore,
        proofs: slackBackfillDiagnostics.flatMap(buildSlackBackfillSyncProofs),
        diagnostics: {
          slackBackfillConversations: slackBackfillDiagnostics,
        },
      };
    }

    for (const conversation of orderedConversations) {
      const isKnownConversation = knownConversationIds.has(conversation.id);
      knownConversationIds.add(conversation.id);
      if (
        scan.mode === "incremental" &&
        isKnownConversation &&
        !shouldFetchConversationIncrementally(conversation, scan.oldestMs)
      ) {
        continue;
      }

      const conversationOldestMs = getConversationHistoryOldestMs(
        scan.mode,
        scan.oldestMs,
        conversation,
        observedBase,
      );
      const memberIds = await listConversationMembers(client, conversation);
      const messages = await listConversationMessages(
        client,
        conversation.id,
        conversationOldestMs,
        messagesPageLimit,
        repliesPageLimit,
      );

      rawEvents.push(
        buildSlackConversationEvent({
          teamId,
          accountKey,
          conversation,
          observedAt: observedBase,
          memberIds,
          selfUserId,
          usersById,
        }),
      );

      rawEvents.push(
        ...buildSlackMessageEvents({
          teamId,
          accountKey,
          conversationId: conversation.id,
          selfUserId,
          observedAt: observedBase,
          messages,
        }),
      );

      slackBackfillDiagnostics.push(
        buildCompleteSlackBackfillConversationProof({
          teamId,
          accountKey,
          conversation,
          family,
          scanMode: scan.mode,
          scanStartedAt: scan.startedAt,
          knownConversationCount: knownConversationIds.size,
          observedAt: observedBase,
          messages,
        }),
      );
    }
  }

  let sourceCursor: SlackSourceCursor;
  let hasMore = false;

  if (scan.mode === "full") {
    const currentFamily = scan.conversationFamily ?? "direct";
    const currentPage = conversationPages[0].page;
    // Slack can return an empty page with a dangling cursor once it has exhausted
    // the current conversation family that the token can actually access.
    const nextCursor = currentPage.conversations.length > 0 ? currentPage.nextCursor || null : null;
    const nextFamily = nextConversationFamily(currentFamily);
    const nextScanFamily = nextCursor != null ? currentFamily : nextFamily;

    if (nextScanFamily) {
      hasMore = true;
      sourceCursor = {
        teamId,
        selfUserId,
        lastSyncAt: previousLastSyncAt,
        knownConversationIds: Array.from(knownConversationIds).sort(),
        scan: {
          ...scan,
          usersComplete: scan.usersComplete,
          conversationFamily: nextScanFamily,
          conversationCursor: nextCursor != null ? nextCursor : null,
        },
      };
    } else {
      sourceCursor = {
        teamId,
        selfUserId,
        lastSyncAt: scan.startedAt,
        knownConversationIds: Array.from(knownConversationIds).sort(),
      };
    }
  } else {
    sourceCursor = {
      teamId,
      selfUserId,
      lastSyncAt: scan.startedAt,
      knownConversationIds: Array.from(knownConversationIds).sort(),
    };
  }

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor,
    syncMode: scan.mode,
    hasMore,
    proofs: slackBackfillDiagnostics.flatMap(buildSlackBackfillSyncProofs),
    diagnostics:
      slackBackfillDiagnostics.length > 0
        ? { slackBackfillConversations: slackBackfillDiagnostics }
        : undefined,
  };
}
