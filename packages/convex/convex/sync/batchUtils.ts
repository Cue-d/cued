/**
 * Generic batch fetch utilities for sync operations.
 * Replaces platform-specific batch fetch functions with a single generic implementation.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BATCH_SIZE } from "./shared";

type Platform = "imessage" | "slack" | "linkedin" | "signal";

/**
 * Batch fetch existing conversations by platform and platformConversationId.
 *
 * @param ctx - Mutation context
 * @param userId - User ID
 * @param platform - Platform to filter by
 * @param platformConversationIds - Array of platform-specific conversation IDs
 * @param batchSize - Optional batch size (defaults to BATCH_SIZE)
 * @returns Array of existing conversations
 */
export async function batchFetchConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: Platform,
  platformConversationIds: string[],
  batchSize = BATCH_SIZE
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  for (let i = 0; i < platformConversationIds.length; i += batchSize) {
    const batch = platformConversationIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", platform)
            .eq("platformConversationId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((c): c is Doc<"conversations"> => c !== null)
    );
  }

  return results;
}

/**
 * Batch fetch existing messages by platform and platformMessageId.
 *
 * @param ctx - Mutation context
 * @param userId - User ID
 * @param platform - Platform to filter by
 * @param platformMessageIds - Array of platform-specific message IDs
 * @param batchSize - Optional batch size (defaults to BATCH_SIZE)
 * @returns Array of existing messages
 */
export async function batchFetchMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: Platform,
  platformMessageIds: string[],
  batchSize = BATCH_SIZE
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  for (let i = 0; i < platformMessageIds.length; i += batchSize) {
    const batch = platformMessageIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", platform)
            .eq("platformMessageId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((m): m is Doc<"messages"> => m !== null)
    );
  }

  return results;
}

/**
 * Create a map of platformId -> Doc for quick lookups.
 * Useful when processing batches of items that may or may not exist.
 */
export function createConversationMap(
  conversations: Doc<"conversations">[]
): Map<string, Doc<"conversations">> {
  return new Map(conversations.map((c) => [c.platformConversationId, c]));
}

/**
 * Create a map of platformMessageId -> Doc for quick lookups.
 */
export function createMessageMap(
  messages: Doc<"messages">[]
): Map<string, Doc<"messages">> {
  return new Map(messages.map((m) => [m.platformMessageId, m]));
}
