/**
 * Shared helpers for merging messageQueue entries into message query results.
 * Used by messages.ts and actions.ts to show optimistic "sending" messages.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Statuses that should appear as optimistic messages in conversation threads */
const VISIBLE_QUEUE_STATUSES = new Set(["pending", "sending", "failed"]);

/**
 * Get active (non-terminal) messageQueue entries for a conversation.
 * Returns entries with status: pending, sending, or failed.
 */
export async function getQueuedMessagesForConversation(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">
): Promise<Doc<"messageQueue">[]> {
  const entries = await ctx.db
    .query("messageQueue")
    .withIndex("by_conversation_sequence", (q) =>
      q.eq("conversationId", conversationId)
    )
    .collect();

  return entries.filter(
    (m) => m.userId === userId && VISIBLE_QUEUE_STATUSES.has(m.status)
  );
}

/**
 * Get the most recent active queue entry for a conversation.
 * Used by fetchInbox to update conversation preview text.
 */
export async function getLatestQueuedForConversation(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">
): Promise<Doc<"messageQueue"> | null> {
  const entries = await getQueuedMessagesForConversation(
    ctx,
    userId,
    conversationId
  );
  if (entries.length === 0) return null;

  // Return the one with the latest createdAt
  return entries.reduce((latest, entry) =>
    entry.createdAt > latest.createdAt ? entry : latest
  );
}

/** Map queue status to message display status */
function mapQueueStatus(
  entry: Doc<"messageQueue">
): "queued" | "sending" | "failed" | "sent" {
  if (entry.status === "pending") return "queued";
  if (entry.status === "failed") return "failed";
  if (entry.status === "sent") return "sent";
  return "sending";
}

/**
 * Map a messageQueue entry to the shape returned by getMessages.
 */
export function mapQueueToInboxMessage(entry: Doc<"messageQueue">) {
  return {
    _id: entry._id as unknown as Id<"messages">,
    content: entry.text,
    sentAt: entry.createdAt,
    isFromMe: true as const,
    platform: entry.platform,
    status: mapQueueStatus(entry),
    reactions: null as string[] | null,
    sender: null,
  };
}

/**
 * Map a messageQueue entry to the shape returned by getActionWithContext messages.
 */
export function mapQueueToDisplayMessage(entry: Doc<"messageQueue">) {
  return {
    _id: entry._id as unknown as Id<"messages">,
    content: entry.text,
    sentAt: entry.createdAt,
    isFromMe: true as const,
    senderName: "You" as string | null,
    senderContactId: null as Id<"contacts"> | null,
    status: mapQueueStatus(entry),
    reactions: undefined as
      | Array<{
          contactId?: Id<"contacts">;
          isFromMe: boolean;
          emoji: string;
          timestamp: number;
        }>
      | undefined,
  };
}
