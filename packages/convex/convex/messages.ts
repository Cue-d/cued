import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";
import {
  mapQueueToInboxMessage,
} from "./lib/queueMerge";
import { platformValidator } from "./schema";

interface InboxArgs {
  limit?: number;
  cursor?: string;
  platform?: Doc<"conversations">["platform"];
}

interface ParsedInboxCursor {
  timestamp: number;
  conversationId: string | null;
}

interface InboxResult {
  conversations: Array<{
    _id: Id<"conversations">;
    platform: Doc<"conversations">["platform"];
    platformConversationId: string;
    conversationType: Doc<"conversations">["conversationType"];
    displayName: string | null;
    participants: Array<{ _id: Id<"contacts">; displayName: string }>;
    lastMessageText: string | null;
    lastMessageAt: number | null;
    unreadCount: number;
    workspaceId: string | null;
  }>;
  nextCursor: string | null;
}

const EMPTY_INBOX: InboxResult = { conversations: [], nextCursor: null };
const INBOX_BATCH_SCAN_LIMIT = 200;
const BRIDGE_SENT_QUEUE_WINDOW_MS = 120_000;
const SYNC_MATCH_WINDOW_MS = 120_000;
const ACTIVE_PREVIEW_QUEUE_STATUSES = new Set<Doc<"messageQueue">["status"]>([
  "pending",
  "sending",
  "failed",
]);

function normalizeMessageText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function parseInboxCursor(cursor?: string): ParsedInboxCursor | null {
  if (!cursor) return null;
  const trimmed = cursor.trim();
  if (!trimmed) return null;

  const timestampOnly = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(timestampOnly) && /^\d+$/.test(trimmed)) {
    return { timestamp: timestampOnly, conversationId: null };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      lastMessageAt?: unknown;
      conversationId?: unknown;
    };
    if (
      typeof parsed.lastMessageAt === "number" &&
      Number.isFinite(parsed.lastMessageAt) &&
      typeof parsed.conversationId === "string" &&
      parsed.conversationId.length > 0
    ) {
      return {
        timestamp: parsed.lastMessageAt,
        conversationId: parsed.conversationId,
      };
    }
  } catch {
    // Ignore malformed cursor payloads and treat as first-page fetch.
  }

  return null;
}

function getQueueEntryTimestamp(entry: Doc<"messageQueue">): number {
  return entry.createdAt;
}

async function getQueueEntriesForInboxPreview(
  ctx: QueryCtx,
  userId: Id<"users">,
  now: number
): Promise<Doc<"messageQueue">[]> {
  const sentThreshold = now - BRIDGE_SENT_QUEUE_WINDOW_MS;
  const [pending, sending, failed, recentSent] = await Promise.all([
    ctx.db
      .query("messageQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "pending")
      )
      .collect(),
    ctx.db
      .query("messageQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "sending")
      )
      .collect(),
    ctx.db
      .query("messageQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "failed")
      )
      .collect(),
    ctx.db
      .query("messageQueue")
      .withIndex("by_user_status_createdAt", (q) =>
        q
          .eq("userId", userId)
          .eq("status", "sent")
          .gte("createdAt", sentThreshold)
      )
      .collect(),
  ]);

  return [...pending, ...sending, ...failed, ...recentSent];
}

function hasMatchingSyncedMessage(
  messages: Array<{ content: string; sentAt: number; isFromMe: boolean }>,
  queueEntry: Doc<"messageQueue">
): boolean {
  const queueContent = normalizeMessageText(queueEntry.text);
  const queueTimestamp = getQueueEntryTimestamp(queueEntry);

  return messages.some((msg) => {
    if (!msg.isFromMe) return false;
    if (normalizeMessageText(msg.content) !== queueContent) return false;
    return Math.abs(msg.sentAt - queueTimestamp) <= SYNC_MATCH_WINDOW_MS;
  });
}

/**
 * Shared inbox fetching logic used by both authenticated and test queries.
 */
async function fetchInbox(
  ctx: QueryCtx,
  userId: Id<"users">,
  args: InboxArgs
): Promise<InboxResult> {
  const now = Date.now();
  const limit = args.limit ?? 50;
  const parsedCursor = parseInboxCursor(args.cursor);
  const cursorTimestamp = parsedCursor?.timestamp;
  const cursorConversationId = parsedCursor?.conversationId ?? null;

  const shouldIncludeConversation = (conversation: Doc<"conversations">) => {
    if (args.platform && conversation.platform !== args.platform) return false;
    if (conversation.platform !== "slack") return true;
    if (conversation.conversationType === "dm" || conversation.conversationType === "group") {
      return true;
    }
    return conversation.userParticipated === true;
  };

  // Scan candidates that have lastMessageAt using the inbox index.
  // Keep a set to dedupe when we stitch in full timestamp "tie" batches.
  const indexedCandidates: Doc<"conversations">[] = [];
  const indexedCandidateIds = new Set<string>();
  let scanCursor = cursorTimestamp;
  let reachedEnd = false;
  const scanBatchSize = Math.min(Math.max((limit + 1) * 3, 50), INBOX_BATCH_SCAN_LIMIT);

  const appendIndexedCandidate = (conversation: Doc<"conversations">) => {
    if (conversation.lastMessageAt === undefined) return;
    if (!shouldIncludeConversation(conversation)) return;
    const key = conversation._id as string;
    if (indexedCandidateIds.has(key)) return;
    indexedCandidateIds.add(key);
    indexedCandidates.push(conversation);
  };

  // For structured cursors, resume within the same timestamp bucket first,
  // then continue scanning strictly older timestamps.
  if (cursorTimestamp !== undefined && cursorConversationId) {
    const tieBatch = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) =>
        q.eq("userId", userId).eq("lastMessageAt", cursorTimestamp)
      )
      .order("desc")
      .collect();

    let pastCursorConversation = false;
    for (const conversation of tieBatch) {
      if ((conversation._id as string) === cursorConversationId) {
        pastCursorConversation = true;
        continue;
      }
      if (!pastCursorConversation) continue;
      appendIndexedCandidate(conversation);
      if (indexedCandidates.length >= limit + 1) break;
    }
  }

  while (indexedCandidates.length < limit + 1 && !reachedEnd) {
    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => {
        const base = q.eq("userId", userId);
        return scanCursor !== undefined ? base.lt("lastMessageAt", scanCursor) : base;
      })
      .order("desc")
      .take(scanBatchSize);

    if (batch.length === 0) {
      reachedEnd = true;
      break;
    }

    for (const conversation of batch) {
      appendIndexedCandidate(conversation);
    }

    const last = batch[batch.length - 1];
    if (last.lastMessageAt === undefined) {
      reachedEnd = true;
      break;
    }

    // If we filled the scan batch, we may have cut through conversations
    // sharing the same boundary timestamp. Pull that whole tie bucket once
    // so those conversations are not skipped by the next strict lt() scan.
    if (batch.length === scanBatchSize) {
      const tieBatch = await ctx.db
        .query("conversations")
        .withIndex("by_user_last_message", (q) =>
          q.eq("userId", userId).eq("lastMessageAt", last.lastMessageAt)
        )
        .order("desc")
        .collect();
      for (const conversation of tieBatch) {
        appendIndexedCandidate(conversation);
      }
    } else {
      reachedEnd = true;
      break;
    }

    scanCursor = last.lastMessageAt;
  }

  const hasMoreIndexed = indexedCandidates.length > limit;
  const indexedPage = hasMoreIndexed
    ? indexedCandidates.slice(0, limit)
    : indexedCandidates;
  const page = [...indexedPage];

  // Fallback for conversations without lastMessageAt on first page only.
  // These rows are used only to fill visible slots and do not drive nextCursor.
  if (page.length < limit && cursorTimestamp === undefined) {
    const fallback = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const sortedFallback = fallback
      .filter((conversation) =>
        conversation.lastMessageAt === undefined && shouldIncludeConversation(conversation)
      )
      .sort((a, b) => b._creationTime - a._creationTime);
    for (const conversation of sortedFallback) {
      if (page.length >= limit) break;
      page.push(conversation);
    }
  }

  // Batch fetch participant contacts across the page.
  const participantIds = [
    ...new Set(page.flatMap((conversation) => conversation.participantContactIds)),
  ];
  const participantContacts = await Promise.all(
    participantIds.map((id) => ctx.db.get(id))
  );
  const participantMap = new Map(
    participantIds
      .map((id, i) => [id as string, participantContacts[i]])
      .filter(
        (entry): entry is [string, Doc<"contacts">] =>
          entry[1] !== null
      )
  );

  // For DM conversations, resolve handles by (platform, contactId).
  const dmHandleKeys = [
    ...new Set(
      page
        .filter((conversation) => conversation.conversationType === "dm")
        .flatMap((conversation) =>
          conversation.participantContactIds.map(
            (contactId) => `${conversation.platform}:${contactId}`
          )
        )
    ),
  ];

  const dmHandles = await Promise.all(
    dmHandleKeys.map(async (key) => {
      const [platform, contactId] = key.split(":");
      const handle = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) =>
          q.eq("contactId", contactId as Id<"contacts">)
        )
        .filter((q) => q.eq(q.field("platform"), platform))
        .first();
      return [key, handle?.handle] as const;
    })
  );
  const handleMap = new Map(
    dmHandles.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );

  const conversationsWithParticipants = page.map((conversation) => {
    const isDm = conversation.conversationType === "dm";
    const participants = conversation.participantContactIds
      .map((contactId) => {
        const contact = participantMap.get(contactId as string);
        if (!contact) return null;
        const participant: {
          _id: Id<"contacts">;
          displayName: string;
          handle?: string;
        } = {
          _id: contact._id,
          displayName: contact.displayName,
        };
        if (isDm) {
          const handle = handleMap.get(`${conversation.platform}:${contactId}`);
          if (handle) participant.handle = handle;
        }
        return participant;
      })
      .filter((participant): participant is NonNullable<typeof participant> => participant !== null);

    // For groups without displayName, build name from participants
    let displayName: string | null = conversation.displayName ?? null;
    if (
      conversation.conversationType !== "dm" &&
      !displayName &&
      participants.length > 0
    ) {
      displayName = participants.map((p) => p.displayName).join(", ");
    }

    return {
      _id: conversation._id,
      platform: conversation.platform,
      platformConversationId: conversation.platformConversationId,
      conversationType: conversation.conversationType,
      displayName,
      participants,
      lastMessageText: conversation.lastMessageText ?? null,
      lastMessageAt: conversation.lastMessageAt ?? null,
      unreadCount: conversation.unreadCount,
      workspaceId: conversation.workspaceId ?? null,
    };
  });

  // Merge queued messages into conversation previews.
  // Query only active states plus recent sent entries to avoid scanning full queue history.
  const allQueueEntries = await getQueueEntriesForInboxPreview(ctx, userId, now);
  const pageConversationIds = new Set(conversationsWithParticipants.map((c) => c._id as string));

  const activeQueueByConversation = new Map<string, Doc<"messageQueue">>();
  for (const entry of allQueueEntries) {
    if (!entry.conversationId) {
      continue;
    }
    const convId = entry.conversationId as string;
    if (!pageConversationIds.has(convId)) {
      continue;
    }

    const shouldIncludeInPreview =
      ACTIVE_PREVIEW_QUEUE_STATUSES.has(entry.status) ||
      (entry.status === "sent" &&
        now - getQueueEntryTimestamp(entry) <= BRIDGE_SENT_QUEUE_WINDOW_MS);

    if (!shouldIncludeInPreview) {
      continue;
    }

    const existing = activeQueueByConversation.get(convId);
    if (
      !existing ||
      getQueueEntryTimestamp(entry) > getQueueEntryTimestamp(existing)
    ) {
      activeQueueByConversation.set(convId, entry);
    }
  }

  // Override preview text/time when a queue entry is newer
  for (const conv of conversationsWithParticipants) {
    const latestQueued = activeQueueByConversation.get(conv._id as string);
    const latestQueuedAt = latestQueued
      ? getQueueEntryTimestamp(latestQueued)
      : undefined;
    if (latestQueued && latestQueuedAt && latestQueuedAt > (conv.lastMessageAt ?? 0)) {
      conv.lastMessageText = latestQueued.text;
      conv.lastMessageAt = latestQueuedAt;
    }
  }

  // Re-sort after merging so conversations with queued messages bubble up
  conversationsWithParticipants.sort(
    (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
  );

  // Keep cursor based on the pre-merge page boundary.
  // Queue merge uses ephemeral timestamps that can reshuffle in-page order,
  // and cursoring off that merged order can cause cross-page duplication.
  const lastItem = indexedPage[indexedPage.length - 1];
  const nextCursor =
    hasMoreIndexed && lastItem
      ? JSON.stringify({
          lastMessageAt: lastItem.lastMessageAt,
          conversationId: lastItem._id as string,
        })
      : null;

  return { conversations: conversationsWithParticipants, nextCursor };
}

/**
 * Get inbox (list of conversations) with pagination.
 *
 * Returns conversations sorted by lastMessageAt descending.
 * Includes participant contact names for display.
 */
export const getInbox = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    platform: v.optional(platformValidator),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return EMPTY_INBOX;

    return fetchInbox(ctx, user._id, args);
  },
});

const EMPTY_MESSAGES = { messages: [], nextCursor: null };

/**
 * Get messages for a specific conversation with pagination.
 *
 * Returns messages sorted by sentAt descending (newest first).
 * Includes sender contact info.
 */
export const getMessages = query({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return EMPTY_MESSAGES;

    // Verify conversation belongs to user
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== user._id) {
      return EMPTY_MESSAGES;
    }

    const limit = args.limit ?? 50;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : undefined;

    // Build query with optional cursor filter
    const messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => {
        const base = q.eq("conversationId", args.conversationId);
        return cursorTimestamp !== undefined
          ? base.lt("sentAt", cursorTimestamp)
          : base;
      })
      .order("desc");

    // Fetch one extra to determine if there's a next page
    const messages = await messagesQuery.take(limit + 1);

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;

    type MessageWithSender = {
      _id: Id<"messages">;
      content: string;
      sentAt: number;
      isFromMe: boolean;
      platform: Doc<"messages">["platform"];
      status?: string | null;
      sender: { _id: Id<"contacts">; displayName: string } | null;
    };

    // Batch resolve sender contacts.
    const senderIds = [
      ...new Set(
        page
          .map((message) => message.senderContactId)
          .filter((id): id is Id<"contacts"> => id !== undefined)
      ),
    ];
    const senders = await Promise.all(senderIds.map((id) => ctx.db.get(id)));
    const senderMap = new Map(
      senderIds
        .map((id, i) => [id as string, senders[i]])
        .filter(
          (entry): entry is [string, Doc<"contacts">] =>
            entry[1] !== null
        )
    );

    const messagesWithSender: MessageWithSender[] = page.map((message) => {
      const sender = message.senderContactId
        ? senderMap.get(message.senderContactId as string)
        : null;

      return {
        _id: message._id,
        content: message.content,
        sentAt: message.sentAt,
        isFromMe: message.isFromMe,
        platform: message.platform,
        status: message.status ?? null,
        sender: sender
          ? { _id: sender._id, displayName: sender.displayName }
          : null,
      };
    });

    // Merge queued messages on first page (they're always recent).
    // Sort after merging so queued messages land in correct DESC position —
    // otherwise they end up at the end of the array, and after the frontend
    // reverses to ASC the "Today" date group jumps to the top of the thread.
    if (!args.cursor) {
      const now = Date.now();
      const queueEntries = await ctx.db
        .query("messageQueue")
        .withIndex("by_conversation_sequence", (q) =>
          q.eq("conversationId", args.conversationId)
        )
        .collect();

      const queued = queueEntries.filter((entry) => {
        if (entry.userId !== user._id) return false;
        if (
          entry.status === "pending" ||
          entry.status === "sending" ||
          entry.status === "failed"
        ) {
          return true;
        }
        if (entry.status !== "sent") return false;

        const queueAge = now - getQueueEntryTimestamp(entry);
        if (queueAge > BRIDGE_SENT_QUEUE_WINDOW_MS) return false;

        return !hasMatchingSyncedMessage(messagesWithSender, entry);
      });

      if (queued.length > 0) {
        messagesWithSender.push(...queued.map(mapQueueToInboxMessage));
        messagesWithSender.sort((a, b) => b.sentAt - a.sentAt);
      }
    }

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem?.sentAt ? String(lastItem.sentAt) : null;

    return { messages: messagesWithSender, nextCursor };
  },
});

/**
 * Get a conversation by ID.
 * Task 5.8: Used by API routes to get conversation details for message sending.
 */
export const getConversationById = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    return {
      _id: conversation._id,
      platform: conversation.platform,
      platformConversationId: conversation.platformConversationId,
      conversationType: conversation.conversationType,
      displayName: conversation.displayName ?? null,
    };
  },
});
