import { createHash } from "node:crypto";
import {
  type Connection,
  type Conversation,
  type Cookie,
  LinkedInClient,
  type Message,
  type MessagingParticipant,
} from "../adapters/linkedin/api/index.js";
import type { SyncBundle } from "../adapters/types.js";
import { loadIntegrationSecret } from "../integrations/keychain.js";
import { mapWithConcurrency } from "../lib/async.js";
import type {
  ContactHandleInput,
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  SourceAccountInput,
} from "../types/provider.js";

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
>;

function now(): number {
  return Date.now();
}

function getLinkedInFetchConcurrency(): number {
  return Number.isFinite(DEFAULT_LINKEDIN_FETCH_CONCURRENCY) &&
    DEFAULT_LINKEDIN_FETCH_CONCURRENCY > 0
    ? Math.trunc(DEFAULT_LINKEDIN_FETCH_CONCURRENCY)
    : 3;
}

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
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

function normalizeConversationUrn(urn: string): string {
  return urn
    .replace(/^urn:li:fsd_conversation:/, "urn:li:fs_conversation:")
    .replace(/^urn:li:messagingThread:/, "urn:li:fs_conversation:");
}

function normalizeMemberUrn(urn: string): string {
  const nested = urn.match(/^urn:li:msg_messagingparticipant:(.+)$/)?.[1];
  const base = nested ?? urn;
  const id = base.match(/^urn:li:[^:]+:(.+)$/)?.[1];
  return id ? `urn:li:member:${id}` : base;
}

function extractUrnId(urn: string | undefined): string | null {
  if (!urn) {
    return null;
  }
  const match = urn.match(/^urn:li:[^:]+:(.+)$/);
  return match?.[1] ?? null;
}

function linkedinProfileUrlFromUrn(urn: string | undefined): string | null {
  const id = extractUrnId(urn);
  if (!id || /^ACo/i.test(id)) {
    return null;
  }
  return `https://www.linkedin.com/in/${id}`;
}

function bestParticipantName(participant: MessagingParticipant): string {
  if (participant.participantType.member) {
    return [
      participant.participantType.member.firstName,
      participant.participantType.member.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return participant.participantType.organization?.name ?? participant.entityURN;
}

function bestParticipantPhoto(participant: MessagingParticipant): string | null {
  return (
    participant.participantType.member?.picture?.url ??
    participant.participantType.organization?.logoUrl ??
    null
  );
}

function participantHandles(participant: MessagingParticipant): ContactHandleInput[] {
  const handles: ContactHandleInput[] = [
    {
      type: "linkedin_entity_urn",
      value: normalizeMemberUrn(participant.entityURN),
      deterministic: true,
    },
  ];
  const profileUrl =
    participant.participantType.member?.profileUrl ||
    linkedinProfileUrlFromUrn(participant.entityURN);
  if (profileUrl) {
    handles.push({
      type: "linkedin_profile_url",
      value: profileUrl,
      deterministic: true,
    });
  }
  const profileId = extractUrnId(participant.entityURN);
  if (profileId) {
    handles.push({
      type: "linkedin_profile_id",
      value: profileId,
      deterministic: true,
    });
  }
  return handles;
}

function participantSourceKey(participant: MessagingParticipant): string {
  return `linkedin:${normalizeMemberUrn(participant.entityURN)}`;
}

function renderContentAttachments(message: Message): Array<Record<string, unknown>> {
  return (message.renderContent ?? []).map((item) => ({ ...item }));
}

function isLinkedInMessageDeleted(message: Message): boolean {
  return message.messageBodyRenderFormat === "RECALLED";
}

function isLinkedInMessageEdited(message: Message): boolean {
  return message.messageBodyRenderFormat === "EDITED";
}

function loadLinkedInCookies(accountKey: string): Cookie[] {
  const secret = loadIntegrationSecret("linkedin", accountKey).secret;
  const cookies = secret.cookies;
  if (!Array.isArray(cookies)) {
    throw new Error(`LinkedIn Keychain payload for '${accountKey}' is missing cookies`);
  }
  return cookies as Cookie[];
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
): Promise<{ conversations: Conversation[]; syncToken: string | null }> {
  if (syncToken) {
    const incremental = await client.getConversations(syncToken);
    return {
      conversations: incremental.conversations,
      syncToken: incremental.syncToken ?? syncToken,
    };
  }

  const seen = new Map<string, Conversation>();
  const firstPage = await client.getConversations();
  for (const conversation of firstPage.conversations) {
    seen.set(conversation.entityURN, conversation);
  }

  let oldestLastActivity = Math.min(
    ...firstPage.conversations.map((conversation) => conversation.lastActivityAt),
  );
  let pageCount = 1;
  while (
    Number.isFinite(oldestLastActivity) &&
    oldestLastActivity > getHistoryCutoffMs() &&
    pageCount < MAX_CONVERSATION_PAGES
  ) {
    const page = await client.getConversationsBefore(oldestLastActivity - 1);
    if (page.conversations.length === 0) {
      break;
    }
    for (const conversation of page.conversations) {
      seen.set(conversation.entityURN, conversation);
    }
    oldestLastActivity = Math.min(
      ...page.conversations.map((conversation) => conversation.lastActivityAt),
    );
    pageCount += 1;
  }

  return {
    conversations: [...seen.values()],
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
  const embedded = conversation.messages?.elements ?? [];
  for (const message of embedded) {
    seen.set(message.entityURN, message);
  }

  const latest =
    embedded.length > 0 ? { messages: embedded } : await client.getMessages(conversation.entityURN);
  for (const message of latest.messages) {
    seen.set(message.entityURN, message);
  }

  let oldestDeliveredAt = Math.min(
    ...latest.messages.map((message) => message.deliveredAt).filter(Boolean),
  );
  let pageCount = 1;
  while (
    !incremental &&
    Number.isFinite(oldestDeliveredAt) &&
    oldestDeliveredAt > oldestMs &&
    pageCount < MAX_MESSAGE_PAGES
  ) {
    const page = await client.getMessagesBefore(conversation.entityURN, oldestDeliveredAt - 1);
    if (page.messages.length === 0) {
      break;
    }
    for (const message of page.messages) {
      seen.set(message.entityURN, message);
    }
    oldestDeliveredAt = Math.min(
      ...page.messages.map((message) => message.deliveredAt).filter(Boolean),
    );
    pageCount += 1;
  }

  return [...seen.values()]
    .filter((message) => !incremental || message.deliveredAt >= oldestMs)
    .sort((left, right) => left.deliveredAt - right.deliveredAt);
}

export async function buildLinkedInSyncBundle(options?: {
  accountKey?: string;
  lastSyncAt?: number;
  syncToken?: string | null;
  client?: LinkedInClientLike;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const cookies = options?.client ? null : loadLinkedInCookies(accountKey);
  const client = options?.client ?? new LinkedInClient({ cookies: cookies ?? [] });
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
  const { conversations, syncToken } = conversationResult;
  const conversationMessages = await mapWithConcurrency(
    conversations,
    fetchConcurrency,
    async (conversation) => ({
      conversation,
      messages: await listMessagesForConversation(client, conversation, cutoffMs, incremental),
    }),
  );

  const sourceAccounts: SourceAccountInput[] = [
    {
      platform: "linkedin",
      accountKey,
      displayName: "LinkedIn",
    },
  ];

  const rawEvents: SyncBundle["rawEvents"] = [];
  const contactIds = new Set<string>();
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();

  for (const connection of connections) {
    const sourceEntityKey = `linkedin:urn:li:member:${connection.profileId}`;
    const seed = `linkedin:contact:${accountKey}:${sourceEntityKey}:${connection.firstName}:${connection.lastName}:${connection.headline ?? ""}`;
    const id = stableId(seed);
    if (contactIds.has(id)) {
      continue;
    }
    contactIds.add(id);

    rawEvents.push({
      id,
      platform: "linkedin",
      accountKey,
      entityKind: "contact",
      eventKind: "observed",
      externalEntityId: connection.profileId,
      observedAt: observedBase,
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
      } satisfies ContactObservationPayload,
      sourceVersion: "linkedin-v1",
    });
  }

  for (const { conversation, messages } of conversationMessages) {
    const normalizedConversation = normalizeConversationUrn(conversation.entityURN);
    const participantKeys = conversation.conversationParticipants.map((participant) =>
      participantSourceKey(participant),
    );

    const conversationId = stableId(
      `linkedin:conversation:${accountKey}:${normalizedConversation}:${conversation.title}:${participantKeys.join(",")}`,
    );
    if (!conversationIds.has(conversationId)) {
      conversationIds.add(conversationId);
      rawEvents.push({
        id: conversationId,
        platform: "linkedin",
        accountKey,
        entityKind: "conversation",
        eventKind: "observed",
        externalEntityId: normalizedConversation,
        conversationExternalId: normalizedConversation,
        occurredAt: conversation.lastActivityAt,
        observedAt: observedBase,
        dedupeKey: conversationId,
        payload: {
          sourceConversationKey: `linkedin:${normalizedConversation}`,
          conversationType: conversation.groupChat ? "group" : "dm",
          displayName: conversation.title || null,
          nativeConversationKey: normalizedConversation,
          service: "linkedin",
          unreadCount: conversation.unreadCount,
          participants: conversation.conversationParticipants.map((participant) => ({
            sourceEntityKey: participantSourceKey(participant),
            isSelf: normalizeMemberUrn(participant.entityURN) === userEntityUrn,
          })),
        } satisfies ConversationObservationPayload,
        sourceVersion: "linkedin-v1",
      });
    }

    for (const participant of conversation.conversationParticipants) {
      const normalizedParticipantUrn = normalizeMemberUrn(participant.entityURN);
      if (normalizedParticipantUrn === userEntityUrn) {
        continue;
      }
      const seed = `linkedin:participant:${accountKey}:${normalizedParticipantUrn}:${bestParticipantName(participant)}:${participant.participantType.member?.headline ?? ""}`;
      const id = stableId(seed);
      if (contactIds.has(id)) {
        continue;
      }
      contactIds.add(id);
      rawEvents.push({
        id,
        platform: "linkedin",
        accountKey,
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: normalizedParticipantUrn,
        observedAt: observedBase,
        dedupeKey: id,
        payload: {
          sourceEntityKey: participantSourceKey(participant),
          fields: {
            display_name: bestParticipantName(participant),
            company: participant.participantType.member?.headline ?? null,
            photo_url: bestParticipantPhoto(participant),
          },
          sourceProfileUrl:
            participant.participantType.member?.profileUrl ??
            linkedinProfileUrlFromUrn(participant.entityURN),
          handles: participantHandles(participant),
        } satisfies ContactObservationPayload,
        sourceVersion: "linkedin-v1",
      });
    }

    for (const message of messages) {
      const senderUrn = normalizeMemberUrn(message.sender.entityURN);
      const id = stableId(
        `linkedin:message:${accountKey}:${normalizeConversationUrn(message.conversationURN || conversation.entityURN)}:${message.entityURN}:${message.body.text}:${message.messageBodyRenderFormat}`,
      );
      if (messageIds.has(id)) {
        continue;
      }
      messageIds.add(id);
      const attachments = renderContentAttachments(message);
      const isDeleted = isLinkedInMessageDeleted(message);
      const isEdited = isLinkedInMessageEdited(message);
      rawEvents.push({
        id,
        platform: "linkedin",
        accountKey,
        entityKind: "message",
        eventKind: "message_observed",
        externalEntityId: message.entityURN,
        conversationExternalId: normalizedConversation,
        occurredAt: message.deliveredAt,
        observedAt: observedBase,
        dedupeKey: id,
        payload: {
          sourceMessageKey: `linkedin:${message.entityURN}`,
          sourceConversationKey: `linkedin:${normalizeConversationUrn(message.conversationURN || conversation.entityURN)}`,
          senderSourceKey: senderUrn === userEntityUrn ? null : `linkedin:${senderUrn}`,
          sentAt: message.deliveredAt,
          content: isDeleted ? "" : message.body.text,
          service: "linkedin",
          status: "delivered",
          isFromMe: senderUrn === userEntityUrn,
          deliveredAt: message.deliveredAt,
          editedAt: isEdited ? message.deliveredAt : null,
          deletedAt: isDeleted ? message.deliveredAt : null,
          isEdited,
          isDeleted,
          attachments,
        } satisfies MessagePayload,
        sourceVersion: "linkedin-v1",
      });
    }
  }

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor: {
      lastSyncAt: observedBase,
      syncToken,
      userEntityUrn,
    },
    syncMode: incremental ? "incremental" : "full",
  };
}
