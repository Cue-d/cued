"use node";
/**
 * Message action handlers (respond, follow_up, send_message).
 * Handles sending messages via the message queue.
 */

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type {
  ActionSwipeHandler,
  SwipeHandlerContext,
  SwipeHandlerResult,
  RightSwipeInput,
} from "./types";

/**
 * Shared handler for message-based actions.
 * Used by respond, follow_up, and send_message.
 */
export const messageHandler: ActionSwipeHandler = {
  async onSwipeRight(
    { ctx, user, action, now }: SwipeHandlerContext,
    input?: RightSwipeInput
  ): Promise<SwipeHandlerResult> {
    const responseText = input?.responseText;

    // Get conversation to determine platform
    const conversation = action.conversationId
      ? await ctx.db.get(action.conversationId)
      : null;

    const platform = (action.platform ?? conversation?.platform) as
      | "imessage"
      | "gmail"
      | "slack"
      | "linkedin"
      | "twitter"
      | "signal"
      | "whatsapp"
      | undefined;

    let messageSent = false;
    let queuedMessageId: Id<"messageQueue"> | null = null;

    // Handle iMessage, LinkedIn, and Slack sending via unified message queue
    const isQueueablePlatform =
      platform === "imessage" || platform === "linkedin" || platform === "slack";

    if (isQueueablePlatform && responseText) {
      // Validate conversation exists for queueable platforms
      if (!conversation) {
        throw new Error(
          `Cannot send ${platform} message: conversation not found. ` +
            `The conversation may have been deleted.`
        );
      }

      const isGroup =
        conversation.conversationType === "group" ||
        conversation.conversationType === "channel";

      let recipientHandle = "";
      let recipientContactId: Id<"contacts"> | undefined;
      let chatIdentifier: string | undefined;

      if (platform === "slack") {
        // Slack uses platformConversationId (channel ID) for all messages
        chatIdentifier = conversation.platformConversationId;
        if (!chatIdentifier) {
          throw new Error(
            `Cannot send Slack message: missing channel ID for conversation.`
          );
        }
        if (!isGroup && conversation.participantContactIds.length > 0) {
          recipientContactId = conversation.participantContactIds[0];
        }
      } else if (!isGroup && conversation.participantContactIds.length > 0) {
        const participantId = conversation.participantContactIds[0];
        recipientContactId = participantId;

        if (platform === "imessage") {
          const handleDoc = await ctx.db
            .query("contactHandles")
            .withIndex("by_contact", (q) => q.eq("contactId", participantId))
            .filter((q) => q.eq(q.field("platform"), "imessage"))
            .first();

          if (handleDoc) {
            recipientHandle = handleDoc.handle;
          } else {
            throw new Error(
              `Cannot send iMessage: no phone or email handle found for contact.`
            );
          }
        } else if (platform === "linkedin") {
          chatIdentifier = conversation.platformConversationId;
          if (!chatIdentifier) {
            throw new Error(
              `Cannot send LinkedIn message: missing thread ID for conversation.`
            );
          }
          recipientHandle = chatIdentifier;
        }
      } else if (isGroup) {
        chatIdentifier = conversation.platformConversationId;
        if (!chatIdentifier) {
          throw new Error(
            `Cannot send message to group: missing chat identifier.`
          );
        }
      } else {
        throw new Error(
          `Cannot send ${platform} message: unable to determine recipient.`
        );
      }

      // Queue message - we've validated routing info above
      const delaySeconds = user.undoSendDelaySeconds ?? 30;
      const scheduledFor = now + delaySeconds * 1000;

      const messageId = await ctx.db.insert("messageQueue", {
        userId: user._id,
        platform,
        recipientHandle,
        recipientContactId,
        text: responseText,
        isGroup,
        chatIdentifier,
        conversationId: conversation._id,
        actionId: action._id,
        workspaceId: conversation.workspaceId,
        status: "pending",
        scheduledFor,
        attempts: 0,
        createdAt: now,
      });

      // Schedule markReady to trigger subscription update
      await ctx.scheduler.runAt(
        scheduledFor,
        internal.messageQueue.markReady,
        { messageId }
      );

      queuedMessageId = messageId;
      messageSent = true;
    }

    // Note: Gmail uses Nango server-side actions (not message queue)

    return {
      success: true,
      status: "completed",
      data: {
        platform,
        messageSent,
        queuedMessageId,
        responseText,
      },
    };
  },

  async onSwipeLeft(): Promise<SwipeHandlerResult> {
    return {
      success: true,
      status: "discarded",
    };
  },
};

// Export individual handlers that share the same implementation
export const respondHandler = messageHandler;
export const followUpHandler = messageHandler;
export const sendMessageHandler = messageHandler;
