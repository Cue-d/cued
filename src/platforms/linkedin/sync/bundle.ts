import { createHash } from "node:crypto";
import type { SourceAccountInput } from "../../../core/types/provider.js";
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
  normalizeMemberUrn,
  participantSourceKey,
} from "./events.js";

const DEFAULT_SYNC_HISTORY_DAYS = Number(process.env.CUED_SYNC_HISTORY_DAYS ?? "730");
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

function getHistoryCutoffMs(): number {
  return now() - DEFAULT_SYNC_HISTORY_DAYS * 24 * 60 * 60 * 1000;
}

function incrementalOldestMs(lastSyncAt?: number): number {
  if (lastSyncAt && lastSyncAt > 0) {
    return Math.max(0, lastSyncAt - INCREMENTAL_BUFFER_MS);
  }
  return getHistoryCutoffMs();
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
): Promise<{
  conversations: Conversation[];
  removedConversationURNs: string[];
  syncToken: string | null;
}> {
  if (syncToken) {
    const incremental = await client.getConversations(syncToken);
    return {
      conversations: incremental.conversations,
      removedConversationURNs: incremental.deletedConversationURNs ?? [],
      syncToken: incremental.syncToken ?? syncToken,
    };
  }

  const seen = new Map<string, Conversation>();
  const firstPage = await client.getConversations();
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
    oldestLastActivity > getHistoryCutoffMs() &&
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

  return {
    conversations: [...seen.values()],
    removedConversationURNs: firstPage.deletedConversationURNs ?? [],
    syncToken: firstPage.syncToken ?? null,
  };
}

async function listMessagesForConversation(
  client: LinkedInClientLike,
  conversation: Conversation,
  oldestMs: number,
  incremental: boolean,
): Promise<Message[]> {
  const seen = new Map<string, Message>();
  for (const message of conversation.messages?.elements ?? []) {
    if (message.entityURN) {
      seen.set(message.entityURN, message);
    }
  }

  let latest: MessagesResult;
  try {
    latest = await client.getMessages(conversation.entityURN);
  } catch (error) {
    if (isLinkedInLegacyPaginationError(error)) {
      return [...seen.values()]
        .filter((message) => message.entityURN)
        .filter((message) => !incremental || message.deliveredAt >= oldestMs)
        .sort((left, right) => left.deliveredAt - right.deliveredAt);
    }
    throw error;
  }
  for (const message of latest.messages) {
    if (message.entityURN) {
      seen.set(message.entityURN, message);
    }
  }

  let prevCursor = latest.prevCursor ?? null;
  let oldestDeliveredAt =
    latest.messages.length > 0
      ? Math.min(...latest.messages.map((message) => message.deliveredAt).filter(Number.isFinite))
      : Number.POSITIVE_INFINITY;
  let pageCount = 1;

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
        break;
      }
      throw error;
    }
    if (page.messages.length === 0) {
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

  return [...seen.values()]
    .filter((message) => message.entityURN)
    .filter((message) => !incremental || message.deliveredAt >= oldestMs)
    .sort((left, right) => left.deliveredAt - right.deliveredAt);
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
  client?: LinkedInClientLike;
  loadProjectedReactions?: ProjectedReactionLookup;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
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
    const cutoffMs = incrementalOldestMs(options?.lastSyncAt);
    const incremental = Boolean(options?.lastSyncAt || options?.syncToken);
    const fetchConcurrency = getLinkedInFetchConcurrency();
    const [selfEntityUrn, conversationResult, connections] = await Promise.all([
      client.fetchSelf(),
      listConversations(client, options?.syncToken ?? null),
      listConnections(client, incremental),
    ]);
    const userEntityUrn = normalizeMemberUrn(selfEntityUrn);

    const sourceAccounts: SourceAccountInput[] = [
      {
        platform: "linkedin",
        accountKey,
        displayName: "LinkedIn",
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

    const conversationMessages = await mapWithConcurrency(
      validConversations,
      fetchConcurrency,
      async (conversation) => ({
        conversation,
        messages: await listMessagesForConversation(client, conversation, cutoffMs, incremental),
      }),
    );

    for (const { conversation, messages } of conversationMessages) {
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
    }

    return {
      sourceAccounts,
      rawEvents,
      sourceCursor: {
        lastSyncAt: observedBase,
        syncToken: conversationResult.syncToken,
        userEntityUrn,
      },
      syncMode: incremental ? "incremental" : "full",
    };
  } finally {
    db?.close();
  }
}
