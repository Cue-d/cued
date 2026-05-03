import { createHash } from "node:crypto";
import type { SourceAccountInput, SyncProofInput } from "../../../core/types/provider.js";
import { mapWithConcurrency } from "../../../core/utils/async.js";
import { openCuedDatabaseReadOnly } from "../../../db/database.js";
import type { SyncBundle } from "../../core/sync.js";
import {
  type Connection,
  type Conversation,
  type Cookie,
  LinkedInClient,
  type Message,
  type MessagesResult,
  type MessagingParticipant,
} from "../api/index.js";
import { LinkedInRequestError } from "../api/request.js";
import { loadLinkedInSessionSecret } from "../auth/session-store.js";
import {
  buildLinkedInConversationEvent,
  buildLinkedInConversationRemovalEvents,
  buildLinkedInMessageEvent,
  buildLinkedInReactionEvent,
  buildLinkedInSystemTimelineEvent,
  buildParticipantContactEvent,
  conversationSourceKey,
  extractReactionTimestamp,
  messageSourceKey,
  normalizeConversationUrn,
  normalizeMemberUrn,
  participantSourceKey,
} from "./events.js";

const INCREMENTAL_BUFFER_MS = 5 * 60 * 1000;
const MAX_CONNECTION_PAGES = Number(process.env.CUED_LINKEDIN_CONNECTION_PAGES ?? "25");
const MAX_CONVERSATION_PAGES = Number(process.env.CUED_LINKEDIN_CONVERSATION_PAGES ?? "50");
const MAX_MESSAGE_PAGES = Number(process.env.CUED_LINKEDIN_MESSAGE_PAGES ?? "10");
const DEFAULT_LINKEDIN_FETCH_CONCURRENCY = Number(
  process.env.CUED_LINKEDIN_FETCH_CONCURRENCY ?? "3",
);

type LinkedInClientLike = Pick<
  LinkedInClient,
  | "fetchSelf"
  | "getConnections"
  | "getConversations"
  | "getConversationsBefore"
  | "getMessages"
  | "getMessagesBefore"
  | "getMessagesWithPrevCursor"
  | "getReactors"
> & {
  getConversationsWithCursor?: LinkedInClient["getConversationsWithCursor"];
};

type ProjectedReactionRow = {
  reactor_source_key: string | null;
  emoji: string;
};

type ProjectedReactionLookup = (
  accountKey: string,
  sourceMessageKey: string,
) => Map<string, ProjectedReactionRow>;

interface LinkedInMessageResumeCursor {
  prevCursor?: string | null;
  oldestDeliveredAt?: number | null;
  oldestMessageAt?: number | null;
  newestMessageAt?: number | null;
  messageCount?: number;
  reason?: string;
}

interface LinkedInFullScanCursor {
  mode: "full";
  startedAt: number;
  conversationCursor?: string | null;
  oldestLastActivity?: number | null;
  activeConversation?: Conversation | null;
  activeMessageCursor?: LinkedInMessageResumeCursor | null;
  pendingConversations?: Conversation[];
}

interface LinkedInSourceCursor {
  lastSyncAt?: number;
  syncToken?: string | null;
  userEntityUrn?: string;
  scan?: LinkedInFullScanCursor;
}

type LinkedInSyncProofState = {
  discoveryScan: LinkedInFullScanCursor | null;
  messageCursors: Map<string, LinkedInMessageResumeCursor>;
};

interface LinkedInMessageBatchResult {
  messages: Message[];
  complete: boolean;
  resumeCursor: LinkedInMessageResumeCursor | null;
  coverage: {
    oldestMessageAt: number | null;
    newestMessageAt: number | null;
  };
  messageCount: number;
  error?: unknown;
}

function now(): number {
  return Date.now();
}

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function getLinkedInFetchConcurrency(): number {
  return Number.isFinite(DEFAULT_LINKEDIN_FETCH_CONCURRENCY) &&
    DEFAULT_LINKEDIN_FETCH_CONCURRENCY > 0
    ? Math.trunc(DEFAULT_LINKEDIN_FETCH_CONCURRENCY)
    : 3;
}

function incrementalOldestMs(lastSyncAt?: number): number {
  if (lastSyncAt && lastSyncAt > 0) {
    return Math.max(0, lastSyncAt - INCREMENTAL_BUFFER_MS);
  }
  return 0;
}

function mergeNullableMin(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (left == null) {
    return right ?? null;
  }
  if (right == null) {
    return left;
  }
  return Math.min(left, right);
}

function mergeNullableMax(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (left == null) {
    return right ?? null;
  }
  if (right == null) {
    return left;
  }
  return Math.max(left, right);
}

function parseConversations(value: unknown): Conversation[] {
  return Array.isArray(value) ? (value.filter(Boolean) as Conversation[]) : [];
}

function parseLinkedInMessageResumeCursor(raw: unknown): LinkedInMessageResumeCursor | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  return {
    prevCursor:
      typeof value.prevCursor === "string" || value.prevCursor === null
        ? value.prevCursor
        : undefined,
    oldestDeliveredAt:
      typeof value.oldestDeliveredAt === "number" || value.oldestDeliveredAt === null
        ? value.oldestDeliveredAt
        : undefined,
    oldestMessageAt:
      typeof value.oldestMessageAt === "number" || value.oldestMessageAt === null
        ? value.oldestMessageAt
        : undefined,
    newestMessageAt:
      typeof value.newestMessageAt === "number" || value.newestMessageAt === null
        ? value.newestMessageAt
        : undefined,
    messageCount: typeof value.messageCount === "number" ? value.messageCount : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function parseLinkedInFullScanCursor(raw: unknown): LinkedInFullScanCursor | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const parsed = raw as Record<string, unknown>;
  if (parsed.mode !== "full" || typeof parsed.startedAt !== "number") {
    return undefined;
  }
  const activeMessageCursor = parseLinkedInMessageResumeCursor(parsed.activeMessageCursor);
  return {
    mode: "full",
    startedAt: parsed.startedAt,
    conversationCursor:
      typeof parsed.conversationCursor === "string" || parsed.conversationCursor === null
        ? parsed.conversationCursor
        : undefined,
    oldestLastActivity:
      typeof parsed.oldestLastActivity === "number" || parsed.oldestLastActivity === null
        ? parsed.oldestLastActivity
        : undefined,
    activeConversation:
      parsed.activeConversation && typeof parsed.activeConversation === "object"
        ? (parsed.activeConversation as Conversation)
        : null,
    activeMessageCursor,
    pendingConversations: parseConversations(parsed.pendingConversations),
  };
}

function parseLinkedInSourceCursor(raw: unknown): LinkedInSourceCursor | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const scan = parseLinkedInFullScanCursor(value.scan);

  return {
    lastSyncAt: typeof value.lastSyncAt === "number" ? value.lastSyncAt : undefined,
    syncToken:
      typeof value.syncToken === "string" || value.syncToken === null ? value.syncToken : undefined,
    userEntityUrn: typeof value.userEntityUrn === "string" ? value.userEntityUrn : undefined,
    scan,
  };
}

function parseLinkedInSyncProofState(raw: unknown, accountKey: string): LinkedInSyncProofState {
  const state: LinkedInSyncProofState = {
    discoveryScan: null,
    messageCursors: new Map(),
  };
  if (!Array.isArray(raw)) {
    return state;
  }

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const proof = entry as Record<string, unknown>;
    const scope =
      proof.scope && typeof proof.scope === "object"
        ? (proof.scope as Record<string, unknown>)
        : null;
    const scopeKind = typeof proof.scopeKind === "string" ? proof.scopeKind : scope?.kind;
    const scopeKey = typeof proof.scopeKey === "string" ? proof.scopeKey : scope?.key;
    const proofKind = typeof proof.proofKind === "string" ? proof.proofKind : null;
    const status = typeof proof.status === "string" ? proof.status : null;
    if (status !== "running") {
      continue;
    }
    if (scopeKind === "account" && scopeKey === accountKey && proofKind === "discovery") {
      state.discoveryScan = parseLinkedInFullScanCursor(proof.resumeCursor) ?? null;
      continue;
    }
    if (scopeKind === "conversation" && typeof scopeKey === "string" && proofKind === "messages") {
      const cursor = parseLinkedInMessageResumeCursor(proof.resumeCursor);
      if (cursor) {
        state.messageCursors.set(scopeKey, cursor);
      }
    }
  }
  return state;
}

function hasInboxCategory(conversation: Conversation): boolean {
  return (
    conversation.categories.includes("INBOX") || conversation.categories.includes("PRIMARY_INBOX")
  );
}

function isSpamConversation(conversation: Conversation): boolean {
  return conversation.categories.includes("SPAM");
}

function userIsConversationMember(conversation: Conversation, userEntityUrn: string): boolean {
  return conversation.conversationParticipants.some(
    (participant) => normalizeMemberUrn(participant.entityURN) === userEntityUrn,
  );
}

function loadLinkedInCookies(accountKey: string): Cookie[] {
  const session = loadLinkedInSessionSecret(accountKey);
  if (!Array.isArray(session.cookies) || session.cookies.length === 0) {
    throw new Error(`LinkedIn Keychain payload for '${accountKey}' is missing cookies`);
  }
  return session.cookies;
}

function buildLinkedInConnectionContactEvent(
  accountKey: string,
  connection: Connection,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const sourceEntityKey = `linkedin:urn:li:member:${connection.profileId}`;
  const id = stableId(
    `linkedin:contact:${accountKey}:${sourceEntityKey}:${connection.firstName}:${connection.lastName}:${connection.headline ?? ""}`,
  );
  return {
    id,
    platform: "linkedin",
    accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: connection.profileId,
    observedAt,
    dedupeKey: id,
    payload: {
      sourceEntityKey,
      fields: {
        display_name:
          [connection.firstName, connection.lastName].filter(Boolean).join(" ").trim() ||
          connection.profileId,
        company: connection.headline ?? null,
        photo_url: connection.picture?.url ?? null,
      },
      sourceProfileUrl: connection.profileUrl ?? null,
      handles: [
        {
          type: "linkedin_profile_id",
          value: connection.profileId,
          deterministic: true,
        },
        ...(connection.profileUrl
          ? [
              {
                type: "linkedin_profile_url",
                value: connection.profileUrl,
                deterministic: true,
              },
            ]
          : []),
      ],
    },
    sourceVersion: "linkedin-v1",
  };
}

async function listConnections(
  client: LinkedInClientLike,
  incremental: boolean,
): Promise<Connection[]> {
  const connections: Connection[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = incremental ? Math.min(2, MAX_CONNECTION_PAGES) : MAX_CONNECTION_PAGES;
  do {
    const result = await client.getConnections(cursor);
    connections.push(...result.connections);
    cursor = result.cursor;
    pages += 1;
  } while (cursor && pages < maxPages);
  return connections;
}

async function listConversations(
  client: LinkedInClientLike,
  syncToken: string | null,
  resumeScan?: LinkedInFullScanCursor,
): Promise<{
  conversations: Conversation[];
  removedConversationURNs: string[];
  syncToken: string | null;
  complete: boolean;
  resumeScan: LinkedInFullScanCursor | null;
}> {
  if (syncToken) {
    const incremental = await client.getConversations(syncToken);
    return {
      conversations: incremental.conversations,
      removedConversationURNs: incremental.deletedConversationURNs ?? [],
      syncToken: incremental.syncToken ?? syncToken,
      complete: true,
      resumeScan: null,
    };
  }

  const pendingConversations = [
    ...(resumeScan?.activeConversation ? [resumeScan.activeConversation] : []),
    ...(resumeScan?.pendingConversations ?? []),
  ];
  if (pendingConversations.length > 0) {
    return {
      conversations: pendingConversations,
      removedConversationURNs: [],
      syncToken: null,
      complete: false,
      resumeScan: {
        mode: "full",
        startedAt: resumeScan?.startedAt ?? now(),
        conversationCursor: resumeScan?.conversationCursor ?? null,
        oldestLastActivity: resumeScan?.oldestLastActivity ?? null,
      },
    };
  }

  const seen = new Map<string, Conversation>();
  const firstPage =
    resumeScan?.conversationCursor && client.getConversationsWithCursor
      ? await client.getConversationsWithCursor(resumeScan.conversationCursor)
      : typeof resumeScan?.oldestLastActivity === "number"
        ? await client.getConversationsBefore(resumeScan.oldestLastActivity - 1)
        : await client.getConversations();
  for (const conversation of firstPage.conversations) {
    seen.set(conversation.entityURN, conversation);
  }

  let oldestLastActivity =
    firstPage.conversations.length > 0
      ? Math.min(...firstPage.conversations.map((conversation) => conversation.lastActivityAt))
      : Number.NEGATIVE_INFINITY;
  let nextCursor = firstPage.nextCursor ?? null;
  let pageCount = 1;
  while (
    firstPage.conversations.length > 0 &&
    Number.isFinite(oldestLastActivity) &&
    pageCount < MAX_CONVERSATION_PAGES
  ) {
    const page =
      nextCursor && client.getConversationsWithCursor
        ? await client.getConversationsWithCursor(nextCursor)
        : await client.getConversationsBefore(oldestLastActivity - 1);
    if (page.conversations.length === 0) {
      break;
    }
    let added = 0;
    for (const conversation of page.conversations) {
      if (!seen.has(conversation.entityURN)) {
        added += 1;
      }
      seen.set(conversation.entityURN, conversation);
    }
    oldestLastActivity = Math.min(
      ...page.conversations.map((conversation) => conversation.lastActivityAt),
    );
    nextCursor = page.nextCursor ?? null;
    if (added === 0 && !nextCursor) {
      break;
    }
    pageCount += 1;
  }

  const complete = !(
    pageCount >= MAX_CONVERSATION_PAGES &&
    ((nextCursor && nextCursor.length > 0) ||
      (Number.isFinite(oldestLastActivity) && oldestLastActivity !== Number.NEGATIVE_INFINITY))
  );

  return {
    conversations: [...seen.values()],
    removedConversationURNs: firstPage.deletedConversationURNs ?? [],
    syncToken: firstPage.syncToken ?? null,
    complete,
    resumeScan: complete
      ? null
      : {
          mode: "full",
          startedAt: resumeScan?.startedAt ?? now(),
          conversationCursor: nextCursor,
          oldestLastActivity: Number.isFinite(oldestLastActivity) ? oldestLastActivity : null,
        },
  };
}

async function listMessagesForConversation(
  client: LinkedInClientLike,
  conversation: Conversation,
  oldestMs: number,
  incremental: boolean,
  resumeCursor?: LinkedInMessageResumeCursor | null,
): Promise<LinkedInMessageBatchResult> {
  const seen = new Map<string, Message>();
  if (!resumeCursor) {
    for (const message of conversation.messages?.elements ?? []) {
      if (message.entityURN) {
        seen.set(message.entityURN, message);
      }
    }
  }

  let prevCursor = resumeCursor?.prevCursor ?? null;
  let oldestDeliveredAt =
    typeof resumeCursor?.oldestDeliveredAt === "number"
      ? resumeCursor.oldestDeliveredAt
      : Number.POSITIVE_INFINITY;
  let pageCount = 0;
  let reachedEnd = false;

  if (!resumeCursor) {
    let latest: MessagesResult;
    try {
      latest = await client.getMessages(conversation.entityURN);
    } catch (error) {
      if (isLinkedInLegacyPaginationError(error)) {
        return buildMessageBatchResult({
          messages: [...seen.values()]
            .filter((message) => message.entityURN)
            .filter((message) => !incremental || message.deliveredAt >= oldestMs)
            .sort((left, right) => left.deliveredAt - right.deliveredAt),
          complete: false,
          resumeCursor: null,
          previousCursor: resumeCursor,
          error: {
            code: "legacy_pagination_400",
            message: error.message,
          },
        });
      }
      throw error;
    }
    pageCount += 1;
    for (const message of latest.messages) {
      if (message.entityURN) {
        seen.set(message.entityURN, message);
      }
    }
    prevCursor = latest.prevCursor ?? null;
    if (latest.messages.length > 0) {
      oldestDeliveredAt = Math.min(
        ...latest.messages.map((message) => message.deliveredAt).filter(Number.isFinite),
      );
    } else if (!prevCursor) {
      oldestDeliveredAt = oldestMs;
      reachedEnd = true;
    }
  }

  while (
    !incremental &&
    pageCount < MAX_MESSAGE_PAGES &&
    ((prevCursor && prevCursor.length > 0) ||
      (Number.isFinite(oldestDeliveredAt) && oldestDeliveredAt > oldestMs))
  ) {
    let page: MessagesResult;
    try {
      page = prevCursor
        ? await client.getMessagesWithPrevCursor(conversation.entityURN, prevCursor)
        : await client.getMessagesBefore(conversation.entityURN, oldestDeliveredAt - 1);
    } catch (error) {
      if (isLinkedInLegacyPaginationError(error)) {
        return buildMessageBatchResult({
          messages: [...seen.values()]
            .filter((message) => message.entityURN)
            .filter((message) => !incremental || message.deliveredAt >= oldestMs)
            .sort((left, right) => left.deliveredAt - right.deliveredAt),
          complete: false,
          resumeCursor: null,
          previousCursor: resumeCursor,
          error: {
            code: "legacy_pagination_400",
            message: error.message,
          },
        });
      }
      throw error;
    }
    if (page.messages.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const message of page.messages) {
      if (message.entityURN) {
        seen.set(message.entityURN, message);
      }
    }
    prevCursor = page.prevCursor ?? null;
    oldestDeliveredAt = Math.min(
      oldestDeliveredAt,
      ...page.messages.map((message) => message.deliveredAt).filter(Number.isFinite),
    );
    pageCount += 1;
  }

  const hasMore =
    !incremental &&
    !reachedEnd &&
    ((prevCursor && prevCursor.length > 0) ||
      (Number.isFinite(oldestDeliveredAt) && oldestDeliveredAt > oldestMs));
  const messages = [...seen.values()]
    .filter((message) => message.entityURN)
    .filter((message) => !incremental || message.deliveredAt >= oldestMs)
    .sort((left, right) => left.deliveredAt - right.deliveredAt);
  return buildMessageBatchResult({
    messages,
    complete: !hasMore,
    resumeCursor: hasMore
      ? {
          prevCursor,
          oldestDeliveredAt: Number.isFinite(oldestDeliveredAt) ? oldestDeliveredAt : null,
          reason: "page_budget_exhausted",
        }
      : null,
    previousCursor: resumeCursor,
  });
}

function reactionCompositeKey(reactorSourceKey: string | null, emoji: string): string {
  return JSON.stringify([reactorSourceKey, emoji]);
}

function loadProjectedReactions(
  db: ReturnType<typeof openCuedDatabaseReadOnly>,
  accountKey: string,
  sourceMessageKey: string,
): Map<string, ProjectedReactionRow> {
  return new Map(
    db
      .listActiveReactionsForMessage("linkedin", accountKey, sourceMessageKey)
      .map((row) => [reactionCompositeKey(row.reactor_source_key, row.emoji), row]),
  );
}

function isLinkedInLegacyPaginationError(error: unknown): error is LinkedInRequestError {
  return error instanceof LinkedInRequestError && error.statusCode === 400;
}

function messageRange(messages: Message[]): { oldest: number | null; newest: number | null } {
  const deliveredAt = messages.map((message) => message.deliveredAt).filter(Number.isFinite);
  if (deliveredAt.length === 0) {
    return { oldest: null, newest: null };
  }
  return {
    oldest: Math.min(...deliveredAt),
    newest: Math.max(...deliveredAt),
  };
}

function buildMessageBatchResult(input: {
  messages: Message[];
  complete: boolean;
  resumeCursor: Pick<
    LinkedInMessageResumeCursor,
    "prevCursor" | "oldestDeliveredAt" | "reason"
  > | null;
  previousCursor?: LinkedInMessageResumeCursor | null;
  error?: unknown;
}): LinkedInMessageBatchResult {
  const range = messageRange(input.messages);
  const coverage = {
    oldestMessageAt: mergeNullableMin(input.previousCursor?.oldestMessageAt, range.oldest),
    newestMessageAt: mergeNullableMax(input.previousCursor?.newestMessageAt, range.newest),
  };
  const messageCount = (input.previousCursor?.messageCount ?? 0) + input.messages.length;
  return {
    messages: input.messages,
    complete: input.complete,
    resumeCursor: input.resumeCursor
      ? {
          ...input.resumeCursor,
          ...coverage,
          messageCount,
        }
      : null,
    coverage,
    messageCount,
    error: input.error,
  };
}

function conversationScope(conversation: Conversation): SyncProofInput["scope"] {
  const normalizedConversation = normalizeConversationUrn(conversation.entityURN);
  return {
    kind: "conversation",
    key: normalizedConversation,
    displayName: conversation.title || null,
    metadata: {
      sourceConversationKey: conversationSourceKey(normalizedConversation),
      groupChat: conversation.groupChat,
      categories: conversation.categories,
    },
  };
}

function trimJoinedName(firstName?: string, lastName?: string): string | null {
  const displayName = [firstName, lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  return displayName.length > 0 ? displayName : null;
}

function inferLinkedInAccountDisplayName(
  conversations: Conversation[],
  userEntityUrn: string,
): string {
  for (const conversation of conversations) {
    for (const participant of conversation.conversationParticipants) {
      if (normalizeMemberUrn(participant.entityURN) !== userEntityUrn) {
        continue;
      }
      const member = participant.participantType.member;
      const displayName = trimJoinedName(member?.firstName, member?.lastName);
      if (displayName) {
        return displayName;
      }
    }
  }
  return "LinkedIn";
}

function buildLinkedInDiscoveryProof(input: {
  accountKey: string;
  accountDisplayName: string;
  observedAt: number;
  runStartedAt: number;
  syncMode: "full" | "incremental";
  complete: boolean;
  resumeScan: LinkedInFullScanCursor | null;
  conversationCount: number;
  syncToken: string | null;
}): SyncProofInput {
  return {
    scope: {
      kind: "account",
      key: input.accountKey,
      displayName: input.accountDisplayName,
    },
    proofKind: "discovery",
    status: input.complete ? "complete" : "running",
    syncMode: input.syncMode,
    observedAt: input.observedAt,
    runStartedAt: input.runStartedAt,
    completedAt: input.complete ? input.observedAt : null,
    resumeCursor: input.complete ? null : input.resumeScan,
    stats: {
      conversationCount: input.conversationCount,
      syncToken: input.syncToken,
    },
  };
}

function buildLinkedInMessagesProof(input: {
  conversation: Conversation;
  messages: Message[];
  coverage: {
    oldestMessageAt: number | null;
    newestMessageAt: number | null;
  };
  messageCount: number;
  observedAt: number;
  runStartedAt: number;
  syncMode: "full" | "incremental";
  complete: boolean;
  resumeCursor: LinkedInMessageResumeCursor | null;
  error?: unknown;
}): SyncProofInput {
  return {
    scope: conversationScope(input.conversation),
    proofKind: "messages",
    status: input.error ? "failed" : input.complete ? "complete" : "running",
    syncMode: input.syncMode,
    observedAt: input.observedAt,
    runStartedAt: input.runStartedAt,
    completedAt: input.complete && !input.error ? input.observedAt : null,
    resumeCursor: input.complete || input.error ? null : input.resumeCursor,
    coverage: input.coverage,
    stats: {
      messageCount: input.messageCount,
    },
    error: input.error,
  };
}

async function buildReactionEventsForMessage(input: {
  loadProjectedReactions: ProjectedReactionLookup;
  client: LinkedInClientLike;
  accountKey: string;
  message: Message;
  conversationUrn: string;
  observedAt: number;
  seenContactIds: Set<string>;
}): Promise<SyncBundle["rawEvents"]> {
  const rawEvents: SyncBundle["rawEvents"] = [];
  const sourceMessageKey = messageSourceKey(input.message.entityURN);
  const projectedReactions = input.loadProjectedReactions(input.accountKey, sourceMessageKey);
  const desiredKeys = new Set<string>();

  for (const summary of input.message.reactionSummaries ?? []) {
    const reactors = await input.client.getReactors(input.message.entityURN, summary.emoji);
    for (const reactor of reactors) {
      const contactEvent = buildParticipantContactEvent(
        input.accountKey,
        reactor,
        input.observedAt,
      );
      if (!input.seenContactIds.has(contactEvent.id)) {
        input.seenContactIds.add(contactEvent.id);
        rawEvents.push(contactEvent);
      }

      const key = reactionCompositeKey(participantSourceKey(reactor), summary.emoji);
      desiredKeys.add(key);
      rawEvents.push(
        buildLinkedInReactionEvent({
          accountKey: input.accountKey,
          message: input.message,
          conversationUrn: input.conversationUrn,
          reactor,
          emoji: summary.emoji,
          observedAt: input.observedAt,
          timestamp: extractReactionTimestamp(summary, input.observedAt),
          isActive: true,
        }),
      );
    }
  }

  for (const [key, projected] of projectedReactions.entries()) {
    if (desiredKeys.has(key)) {
      continue;
    }
    rawEvents.push(
      buildLinkedInReactionEvent({
        accountKey: input.accountKey,
        message: input.message,
        conversationUrn: input.conversationUrn,
        reactor:
          projected.reactor_source_key == null
            ? null
            : ({
                entityURN: projected.reactor_source_key.replace(/^linkedin:/, ""),
                participantType: {},
              } as MessagingParticipant),
        emoji: projected.emoji,
        observedAt: input.observedAt,
        timestamp: input.observedAt,
        isActive: false,
      }),
    );
  }

  return rawEvents;
}

export async function buildLinkedInSyncBundle(options?: {
  accountKey?: string;
  lastSyncAt?: number;
  syncToken?: string | null;
  sourceCursor?: unknown;
  syncProofs?: unknown;
  client?: LinkedInClientLike;
  loadProjectedReactions?: ProjectedReactionLookup;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const savedCursor = parseLinkedInSourceCursor(options?.sourceCursor);
  const syncProofState = parseLinkedInSyncProofState(options?.syncProofs, accountKey);
  const resumeScan = syncProofState.discoveryScan ?? savedCursor?.scan;
  const previousLastSyncAt =
    typeof options?.lastSyncAt === "number" ? options.lastSyncAt : savedCursor?.lastSyncAt;
  const savedSyncToken =
    options?.syncToken !== undefined ? options.syncToken : (savedCursor?.syncToken ?? null);
  const session = options?.client ? null : loadLinkedInSessionSecret(accountKey);
  const client =
    options?.client ??
    new LinkedInClient({
      cookies: loadLinkedInCookies(accountKey),
      pageInstance: session?.pageInstance ?? undefined,
      xLiTrack: session?.xLiTrack ?? undefined,
    });

  const db = options?.loadProjectedReactions ? null : openCuedDatabaseReadOnly();
  const loadProjectedReactionsForSync =
    options?.loadProjectedReactions ??
    ((lookupAccountKey: string, sourceMessageKey: string) =>
      loadProjectedReactions(db!, lookupAccountKey, sourceMessageKey));
  try {
    const observedBase = now();
    const cutoffMs = incrementalOldestMs(previousLastSyncAt);
    const incremental = Boolean(!resumeScan && (previousLastSyncAt || savedSyncToken));
    const syncMode = incremental ? "incremental" : "full";
    const scan: LinkedInFullScanCursor | undefined =
      !incremental && resumeScan
        ? resumeScan
        : !incremental
          ? {
              mode: "full",
              startedAt: observedBase,
            }
          : undefined;
    const fetchConcurrency = getLinkedInFetchConcurrency();
    const [selfEntityUrn, conversationResult, connections] = await Promise.all([
      client.fetchSelf(),
      listConversations(client, incremental ? savedSyncToken : null, scan),
      listConnections(client, incremental),
    ]);
    const userEntityUrn = normalizeMemberUrn(selfEntityUrn);
    const accountDisplayName = inferLinkedInAccountDisplayName(
      conversationResult.conversations,
      userEntityUrn,
    );

    const sourceAccounts: SourceAccountInput[] = [
      {
        platform: "linkedin",
        accountKey,
        displayName: accountDisplayName,
      },
    ];

    const rawEvents: SyncBundle["rawEvents"] = [];
    const seenContactIds = new Set<string>();
    const seenConversationKeys = new Set<string>();
    const seenMessageIds = new Set<string>();

    for (const connection of connections) {
      const event = buildLinkedInConnectionContactEvent(accountKey, connection, observedBase);
      if (seenContactIds.has(event.id)) {
        continue;
      }
      seenContactIds.add(event.id);
      rawEvents.push(event);
    }

    const validConversations: Conversation[] = [];
    const conversationsByUrn = new Map(
      conversationResult.conversations.map((conversation) => [
        conversation.entityURN,
        conversation,
      ]),
    );

    for (const removedUrn of conversationResult.removedConversationURNs) {
      rawEvents.push(
        ...buildLinkedInConversationRemovalEvents({
          accountKey,
          conversationUrn: removedUrn,
          observedAt: observedBase,
          reason: "deleted",
          conversation: conversationsByUrn.get(removedUrn) ?? null,
          userEntityUrn,
        }),
      );
    }

    for (const conversation of conversationResult.conversations) {
      const isMember = userIsConversationMember(conversation, userEntityUrn);
      const shouldRemove =
        isSpamConversation(conversation) || !hasInboxCategory(conversation) || !isMember;
      if (shouldRemove) {
        rawEvents.push(
          ...buildLinkedInConversationRemovalEvents({
            accountKey,
            conversationUrn: conversation.entityURN,
            observedAt: observedBase,
            reason: isSpamConversation(conversation) ? "spam" : !isMember ? "removed" : "archived",
            conversation,
            userEntityUrn,
          }),
        );
        continue;
      }
      validConversations.push(conversation);
    }

    const proofs: SyncProofInput[] = [];
    let stoppedAtConversationIndex: number | null = null;
    let stoppedMessageCursor: LinkedInMessageResumeCursor | null = null;

    const ingestConversation = async (
      conversation: Conversation,
      messages: Message[],
      messageResult: LinkedInMessageBatchResult,
    ) => {
      const conversationKey = conversationSourceKey(conversation.entityURN);
      if (!seenConversationKeys.has(conversationKey)) {
        seenConversationKeys.add(conversationKey);
        rawEvents.push(
          buildLinkedInConversationEvent(accountKey, conversation, userEntityUrn, observedBase),
        );
      }

      for (const participant of conversation.conversationParticipants) {
        const normalizedParticipantUrn = normalizeMemberUrn(participant.entityURN);
        if (normalizedParticipantUrn === userEntityUrn) {
          continue;
        }
        const event = buildParticipantContactEvent(accountKey, participant, observedBase);
        if (seenContactIds.has(event.id)) {
          continue;
        }
        seenContactIds.add(event.id);
        rawEvents.push(event);
      }

      for (const message of messages) {
        if (!message.entityURN) {
          continue;
        }
        if (message.messageBodyRenderFormat === "SYSTEM") {
          rawEvents.push(buildLinkedInSystemTimelineEvent(accountKey, message, observedBase));
          continue;
        }

        const event = buildLinkedInMessageEvent({
          accountKey,
          message,
          fallbackConversationUrn: conversation.entityURN,
          userEntityUrn,
          observedAt: observedBase,
        });
        if (!seenMessageIds.has(event.id)) {
          seenMessageIds.add(event.id);
          rawEvents.push(event);
        }

        rawEvents.push(
          ...(await buildReactionEventsForMessage({
            loadProjectedReactions: loadProjectedReactionsForSync,
            client,
            accountKey,
            message,
            conversationUrn: message.conversationURN || conversation.entityURN,
            observedAt: observedBase,
            seenContactIds,
          })),
        );
      }

      proofs.push(
        buildLinkedInMessagesProof({
          conversation,
          messages,
          coverage: messageResult.coverage,
          messageCount: messageResult.messageCount,
          observedAt: observedBase,
          runStartedAt: scan?.startedAt ?? observedBase,
          syncMode,
          complete: messageResult.complete,
          resumeCursor: messageResult.resumeCursor,
          error: messageResult.error,
        }),
      );
    };

    if (incremental) {
      const conversationMessages = await mapWithConcurrency(
        validConversations,
        fetchConcurrency,
        async (conversation) => ({
          conversation,
          result: await listMessagesForConversation(client, conversation, cutoffMs, true),
        }),
      );

      for (const { conversation, result } of conversationMessages) {
        await ingestConversation(conversation, result.messages, result);
      }
    } else {
      for (const [index, conversation] of validConversations.entries()) {
        const conversationKey = normalizeConversationUrn(conversation.entityURN);
        const resumeCursor =
          scan?.activeConversation?.entityURN === conversation.entityURN
            ? (syncProofState.messageCursors.get(conversationKey) ?? scan.activeMessageCursor)
            : null;
        const result = await listMessagesForConversation(
          client,
          conversation,
          cutoffMs,
          false,
          resumeCursor,
        );
        await ingestConversation(conversation, result.messages, result);
        if (!result.complete && !result.error) {
          stoppedAtConversationIndex = index;
          stoppedMessageCursor = result.resumeCursor;
          break;
        }
      }
    }

    const stoppedConversation =
      stoppedAtConversationIndex == null ? null : validConversations[stoppedAtConversationIndex];
    const pendingConversations =
      stoppedAtConversationIndex == null
        ? []
        : validConversations.slice(stoppedAtConversationIndex + 1);
    const hasMoreConversationPages = Boolean(
      conversationResult.resumeScan?.conversationCursor ||
        typeof conversationResult.resumeScan?.oldestLastActivity === "number",
    );
    const hasMore =
      !incremental &&
      (Boolean(stoppedConversation) || hasMoreConversationPages || pendingConversations.length > 0);
    const nextScan =
      hasMore && scan
        ? {
            mode: "full" as const,
            startedAt: scan.startedAt,
            conversationCursor: conversationResult.resumeScan?.conversationCursor ?? null,
            oldestLastActivity: conversationResult.resumeScan?.oldestLastActivity ?? null,
            activeConversation: stoppedConversation,
            activeMessageCursor: stoppedMessageCursor,
            pendingConversations,
          }
        : undefined;
    const discoveryComplete = !hasMore;
    proofs.unshift(
      buildLinkedInDiscoveryProof({
        accountKey,
        accountDisplayName,
        observedAt: observedBase,
        runStartedAt: scan?.startedAt ?? observedBase,
        syncMode,
        complete: discoveryComplete,
        resumeScan: discoveryComplete ? null : (nextScan ?? null),
        conversationCount: conversationResult.conversations.length,
        syncToken: conversationResult.syncToken ?? savedSyncToken,
      }),
    );

    return {
      sourceAccounts,
      rawEvents,
      sourceCursor: {
        lastSyncAt: hasMore ? previousLastSyncAt : observedBase,
        syncToken: conversationResult.syncToken ?? savedSyncToken,
        userEntityUrn,
      },
      syncMode,
      hasMore,
      continuation: hasMore
        ? {
            reason: stoppedConversation ? "scoped_proof_continuation" : "account_pagination",
            detail: stoppedConversation
              ? "LinkedIn conversation message proof is still running"
              : "LinkedIn conversation discovery page remains",
            scope: stoppedConversation
              ? {
                  kind: "conversation",
                  key: stoppedConversation.entityURN,
                  proofKind: "messages",
                }
              : {
                  kind: "account",
                  key: "conversations",
                  proofKind: "discovery",
                },
          }
        : undefined,
      proofs,
    };
  } finally {
    db?.close();
  }
}
