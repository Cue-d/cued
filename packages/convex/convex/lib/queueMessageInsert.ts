import type { ActionPlatform } from "@cued/shared";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export interface InsertQueuedMessageArgs {
  userId: Id<"users">;
  platform: ActionPlatform;
  recipientHandle: string;
  recipientContactId?: Id<"contacts">;
  text: string;
  isGroup: boolean;
  chatIdentifier?: string;
  conversationId?: Id<"conversations">;
  actionId?: Id<"actions">;
  workspaceId?: string;
  now?: number;
  scheduledFor?: number;
}

/**
 * Insert a pending message queue entry with per-conversation sequence ordering.
 * Returns the created message ID and effective scheduled timestamp.
 */
export async function insertQueuedMessage(
  ctx: MutationCtx,
  args: InsertQueuedMessageArgs
): Promise<{ messageId: Id<"messageQueue">; scheduledFor: number }> {
  const now = args.now ?? Date.now();
  const scheduledFor = args.scheduledFor ?? now;

  let sequenceNumber = 0;
  if (args.conversationId) {
    const lastInConversation = await ctx.db
      .query("messageQueue")
      .withIndex("by_conversation_sequence", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .first();
    sequenceNumber = (lastInConversation?.sequenceNumber ?? -1) + 1;
  }

  const messageId = await ctx.db.insert("messageQueue", {
    userId: args.userId,
    platform: args.platform,
    recipientHandle: args.recipientHandle,
    recipientContactId: args.recipientContactId,
    text: args.text,
    isGroup: args.isGroup,
    chatIdentifier: args.chatIdentifier,
    conversationId: args.conversationId,
    actionId: args.actionId,
    workspaceId: args.workspaceId,
    status: "pending",
    scheduledFor,
    sequenceNumber,
    attempts: 0,
    createdAt: now,
  });

  return { messageId, scheduledFor };
}
