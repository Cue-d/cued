import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import { adjustPendingActionCount } from "./lib/actions";
import {
  actionStatusValidator,
  actionTypeValidator,
  platformValidator,
} from "./schema";

/**
 * Fetch all actionable items: pending actions + snoozed actions that are due.
 * This is the core logic for determining what needs user attention.
 */
async function fetchActionableActions(
  ctx: QueryCtx,
  userId: Id<"users">
): Promise<Doc<"actions">[]> {
  const now = Date.now();

  const [pendingActions, snoozedActions] = await Promise.all([
    ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "pending")
      )
      .collect(),
    ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "snoozed")
      )
      .collect(),
  ]);

  const dueSnoozedActions = snoozedActions.filter(
    (a) => a.snoozedUntil && a.snoozedUntil <= now
  );

  return [...pendingActions, ...dueSnoozedActions];
}

/** Enrich an action with related contact and conversation data. */
async function enrichAction(
  ctx: QueryCtx,
  action: Doc<"actions">
): Promise<{
  _id: Id<"actions">;
  type: Doc<"actions">["type"];
  status: Doc<"actions">["status"];
  priority: number;
  reason: string | null;
  llmReason: string | null;
  createdAt: number;
  snoozedUntil: number | null;
  completedAt: number | null;
  discardedAt: number | null;
  conversationId: Id<"conversations"> | null;
  contactId: Id<"contacts"> | null;
  contactName: string | null;
  secondaryContactId: Id<"contacts"> | null;
  secondaryContactName: string | null;
  mergeSuggestionId: Id<"mergeSuggestions"> | null;
  // Denormalized merge data for resolve_contact actions
  mergeConfidence: number | null;
  mergeSource: string | null;
  mergeReasoning: string | null;
  platform: string | null;
}> {
  const [conversation, contact, secondaryContact] = await Promise.all([
    action.conversationId ? ctx.db.get(action.conversationId) : null,
    action.contactId ? ctx.db.get(action.contactId) : null,
    action.secondaryContactId ? ctx.db.get(action.secondaryContactId) : null,
  ]);

  // Prefer action.platform if set, otherwise derive from conversation
  const platform = action.platform ?? conversation?.platform ?? null;

  // Determine contact name - for groups, use displayName or list participants
  let contactName: string | null = null;
  const isGroup =
    conversation?.conversationType === "group" ||
    conversation?.conversationType === "channel";

  if (isGroup) {
    if (conversation.displayName) {
      contactName = conversation.displayName;
    } else if (conversation.participantContactIds.length) {
      // Fetch participant names for group chats without displayName
      const participants = await Promise.all(
        conversation.participantContactIds.map((id) => ctx.db.get(id))
      );
      const names = participants
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => p.displayName)
        .filter(Boolean);
      contactName = names.length > 0 ? names.join(", ") : null;
    }
  }
  // Fall back to contact name for DMs or if group name resolution failed
  if (!contactName) {
    contactName = contact?.displayName ?? null;
  }

  return {
    _id: action._id,
    type: action.type,
    status: action.status,
    priority: action.priority,
    reason: action.reason ?? null,
    llmReason: action.llmReason ?? null,
    createdAt: action.createdAt,
    snoozedUntil: action.snoozedUntil ?? null,
    completedAt: action.completedAt ?? null,
    discardedAt: action.discardedAt ?? null,
    conversationId: action.conversationId ?? null,
    contactId: action.contactId ?? null,
    contactName,
    secondaryContactId: action.secondaryContactId ?? null,
    secondaryContactName: secondaryContact?.displayName ?? null,
    mergeSuggestionId: action.mergeSuggestionId ?? null,
    // Denormalized merge data for resolve_contact actions
    mergeConfidence: action.mergeConfidence ?? null,
    mergeSource: action.mergeSource ?? null,
    mergeReasoning: action.mergeReasoning ?? null,
    platform,
  };
}

/**
 * Search actions with filters.
 * Supports filtering by status, type, contactId, conversationId, and date ranges.
 */
export const searchActions = query({
  args: {
    status: v.optional(actionStatusValidator),
    type: v.optional(actionTypeValidator),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    createdAfter: v.optional(v.number()), // timestamp in ms
    snoozedUntilBefore: v.optional(v.number()), // timestamp in ms (for finding due snoozed items)
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [] };

    const limit = Math.min(args.limit ?? 20, 100);

    // Start with user-filtered query
    let query = ctx.db
      .query("actions")
      .withIndex("by_user", (q) => q.eq("userId", user._id));

    // If filtering by status, use the compound index for efficiency
    if (args.status) {
      query = ctx.db
        .query("actions")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", args.status!)
        );
    }

    // Fetch all matching records and apply remaining filters in-memory
    // (Convex doesn't support multi-field filtering on non-compound indexes)
    const allActions = await query.collect();

    let filtered = allActions;

    if (args.type) {
      filtered = filtered.filter((a) => a.type === args.type);
    }

    if (args.contactId) {
      filtered = filtered.filter((a) => a.contactId === args.contactId);
    }

    if (args.conversationId) {
      filtered = filtered.filter(
        (a) => a.conversationId === args.conversationId
      );
    }

    if (args.createdAfter) {
      filtered = filtered.filter((a) => a.createdAt >= args.createdAfter!);
    }

    if (args.snoozedUntilBefore) {
      filtered = filtered.filter(
        (a) =>
          a.status === "snoozed" &&
          a.snoozedUntil &&
          a.snoozedUntil <= args.snoozedUntilBefore!
      );
    }

    // Sort by createdAt descending (most recent first)
    filtered.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    const actions = filtered.slice(0, limit);

    const enriched = await Promise.all(
      actions.map((a) => enrichAction(ctx, a))
    );
    return { actions: enriched };
  },
});

/**
 * Create a new action item.
 */
export const createAction = mutation({
  args: {
    type: actionTypeValidator,
    priority: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    messageId: v.optional(v.id("messages")),
    platform: v.optional(platformValidator),
    reason: v.optional(v.string()),
    llmReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const actionId = await ctx.db.insert("actions", {
      userId: user._id,
      type: args.type,
      status: "pending",
      priority: args.priority ?? 50,
      conversationId: args.conversationId,
      contactId: args.contactId,
      messageId: args.messageId,
      platform: args.platform,
      reason: args.reason,
      llmReason: args.llmReason,
      createdAt: Date.now(),
    });

    // Increment pending action count (new actions are always pending)
    await adjustPendingActionCount(ctx, user._id, 1);

    return { actionId };
  },
});

/**
 * Get pending actions for the current user.
 * Includes:
 *  - Actions with status="pending"
 *  - Snoozed actions where snoozedUntil <= now (due to wake up)
 * Supports cursor-based pagination using createdAt timestamp.
 */
export const getPendingActions = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()), // createdAt timestamp of last action
    type: v.optional(actionTypeValidator), // Filter by action type
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 20, 100);

    let actionable = await fetchActionableActions(ctx, user._id);

    // Filter by type if provided
    if (args.type) {
      actionable = actionable.filter((a) => a.type === args.type);
    }

    // Sort by priority DESC, then createdAt DESC
    actionable.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.createdAt - a.createdAt;
    });

    // Apply cursor-based pagination
    let filtered = actionable;
    if (args.cursor) {
      const cursorIdx = filtered.findIndex((a) => a.createdAt < args.cursor!);
      filtered = cursorIdx >= 0 ? filtered.slice(cursorIdx) : [];
    }

    // Take limit + 1 to determine if there's more
    const page = filtered.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const actions = hasMore ? page.slice(0, limit) : page;

    const enriched = await Promise.all(
      actions.map((a) => enrichAction(ctx, a))
    );

    const nextCursor =
      hasMore && actions.length > 0
        ? actions[actions.length - 1].createdAt
        : null;

    return { actions: enriched, nextCursor };
  },
});

/**
 * Update action status (complete, discard, snooze).
 */
export const updateActionStatus = mutation({
  args: {
    actionId: v.id("actions"),
    status: actionStatusValidator,
    snoozedUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const oldStatus = action.status;
    const newStatus = args.status;

    const updates: Partial<Doc<"actions">> = {
      status: args.status,
    };

    const now = Date.now();

    if (args.status === "completed") {
      updates.completedAt = now;
    }

    if (args.status === "discarded") {
      updates.discardedAt = now;
    }

    if (args.status === "snoozed" && args.snoozedUntil) {
      updates.snoozedUntil = args.snoozedUntil;
    }

    await ctx.db.patch(args.actionId, updates);

    // Adjust pending action count based on status change
    if (oldStatus === "pending" && newStatus !== "pending") {
      await adjustPendingActionCount(ctx, user._id, -1);
    } else if (oldStatus !== "pending" && newStatus === "pending") {
      await adjustPendingActionCount(ctx, user._id, 1);
    }

    return { success: true };
  },
});

/**
 * Get a single action with full context: messages and contact info.
 * Used for the action detail view / card.
 */
export const getActionWithContext = query({
  args: {
    actionId: v.id("actions"),
    messageLimit: v.optional(v.number()), // How many messages to include (default 10)
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      return null;
    }

    const messageLimit = Math.min(args.messageLimit ?? 10, 50);

    // Get related conversation if exists
    const conversation = action.conversationId
      ? await ctx.db.get(action.conversationId)
      : null;

    // Get related contact if exists
    const contact = action.contactId
      ? await ctx.db.get(action.contactId)
      : null;

    // Get contact handles if we have a contact
    const handles = contact
      ? await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect()
      : [];

    const secondaryContact = action.secondaryContactId
      ? await ctx.db.get(action.secondaryContactId)
      : null;

    const secondaryHandles = secondaryContact
      ? await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", secondaryContact._id))
          .collect()
      : [];

    // Get recent messages from the conversation
    const messages = action.conversationId
      ? await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) =>
            q.eq("conversationId", action.conversationId!)
          )
          .order("desc")
          .take(messageLimit)
      : [];

    // Resolve sender names for messages
    const messagesWithSender = await Promise.all(
      messages.map(async (msg) => {
        let senderName: string | null = null;
        if (msg.isFromMe) {
          senderName = "You";
        } else if (msg.senderContactId) {
          const sender = await ctx.db.get(msg.senderContactId);
          senderName = sender?.displayName ?? null;
        }

        // Resolve attachment URLs
        const attachmentsWithUrls = msg.attachments
          ? await Promise.all(
              msg.attachments.map(async (att) => ({
                ...att,
                url: await ctx.storage.getUrl(att.storageId),
                thumbnailUrl: att.thumbnailStorageId
                  ? await ctx.storage.getUrl(att.thumbnailStorageId)
                  : null,
              }))
            )
          : null;

        return {
          _id: msg._id,
          content: msg.content,
          sentAt: msg.sentAt,
          isFromMe: msg.isFromMe,
          senderName,
          status: msg.status,
          reactions: msg.reactions,
          attachments: attachmentsWithUrls,
        };
      })
    );

    // Reverse to show oldest first (chronological order for display)
    messagesWithSender.reverse();

    return {
      action: {
        _id: action._id,
        type: action.type,
        status: action.status,
        priority: action.priority,
        reason: action.reason ?? null,
        llmReason: action.llmReason ?? null,
        createdAt: action.createdAt,
        snoozedUntil: action.snoozedUntil ?? null,
        completedAt: action.completedAt ?? null,
        discardedAt: action.discardedAt ?? null,
        platform: action.platform ?? conversation?.platform ?? null,
        secondaryContactId: action.secondaryContactId ?? null,
        mergeSuggestionId: action.mergeSuggestionId ?? null,
      },
      conversation: conversation
        ? {
            _id: conversation._id,
            platform: conversation.platform,
            conversationType: conversation.conversationType,
            displayName: conversation.displayName ?? null,
            lastMessageAt: conversation.lastMessageAt ?? null,
          }
        : null,
      contact: contact
        ? {
            _id: contact._id,
            displayName: contact.displayName,
            company: contact.company ?? null,
            notes: contact.notes ?? null,
            importance: contact.importance ?? null,
            handles: handles.map((h) => ({
              handleType: h.handleType,
              handle: h.handle,
              platform: h.platform,
            })),
          }
        : null,
      secondaryContact: secondaryContact
        ? {
            _id: secondaryContact._id,
            displayName: secondaryContact.displayName,
            company: secondaryContact.company ?? null,
            notes: secondaryContact.notes ?? null,
            importance: secondaryContact.importance ?? null,
            handles: secondaryHandles.map((h) => ({
              handleType: h.handleType,
              handle: h.handle,
              platform: h.platform,
            })),
          }
        : null,
      messages: messagesWithSender,
    };
  },
});

/**
 * Get count of pending actions for sidebar badge.
 * Uses denormalized counter on users table (no expensive queries).
 */
export const getPendingActionCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { count: 0 };

    return { count: user.pendingActionCount ?? 0 };
  },
});

/**
 * Get counts of pending actions grouped by type.
 * Used for filter badges in action queue UI.
 */
export const getActionCountsByType = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { counts: {}, total: 0 };

    const actionable = await fetchActionableActions(ctx, user._id);

    // Group by type
    const counts: Record<string, number> = {};
    for (const action of actionable) {
      counts[action.type] = (counts[action.type] ?? 0) + 1;
    }

    return { counts, total: actionable.length };
  },
});

/**
 * Swipe direction type for action gestures.
 */
const swipeDirectionValidator = v.union(
  v.literal("left"), // discard
  v.literal("right"), // complete/send
  v.literal("up") // snooze
);

/**
 * Handle swipe action with platform routing.
 * - left: discard action
 * - right: complete/send message
 * - up: snooze action until specified time
 */
export const swipeAction = mutation({
  args: {
    actionId: v.id("actions"),
    direction: swipeDirectionValidator,
    snoozedUntil: v.optional(v.number()), // Required for direction='up'
    responseText: v.optional(v.string()), // Optional response text for direction='right'
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const now = Date.now();

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const wasPending = action.status === "pending";

    switch (args.direction) {
      case "left": {
        if (action.type === "resolve_contact" && action.mergeSuggestionId) {
          await ctx.db.patch(action.mergeSuggestionId, {
            status: "rejected",
            resolvedAt: now,
          });
        }

        // Task 8.7: Mark new_connection contact as "not important" (-1)
        if (action.type === "new_connection" && action.contactId) {
          await ctx.db.patch(action.contactId, {
            importance: -1,
          });
        }

        // Discard action
        await ctx.db.patch(args.actionId, {
          status: "discarded",
          discardedAt: now,
        });

        // Decrement counter if was pending
        if (wasPending) {
          await adjustPendingActionCount(ctx, user._id, -1);
        }

        return { success: true, status: "discarded" };
      }

      case "up": {
        // Snooze action
        if (!args.snoozedUntil) {
          throw new Error("snoozedUntil is required for snooze action");
        }
        await ctx.db.patch(args.actionId, {
          status: "snoozed",
          snoozedUntil: args.snoozedUntil,
        });

        // Decrement counter if was pending
        if (wasPending) {
          await adjustPendingActionCount(ctx, user._id, -1);
        }

        return { success: true, status: "snoozed", snoozedUntil: args.snoozedUntil };
      }

      case "right": {
        if (action.type === "resolve_contact") {
          if (!action.contactId || !action.secondaryContactId) {
            throw new Error("resolve_contact action missing contact IDs");
          }

          // Get the merge source from the suggestion if available
          let mergeSource:
            | "email_match"
            | "phone_match"
            | "exact_name_match"
            | "fuzzy_name_match"
            | "llm_fuzzy_match" = "email_match";
          if (action.mergeSuggestionId) {
            const suggestion = await ctx.db.get(action.mergeSuggestionId);
            if (suggestion) {
              mergeSource = suggestion.source;
            }
          }

          await ctx.scheduler.runAfter(
            0,
            internal.contactResolution.autoMergeContacts,
            {
              primaryContactId: action.contactId,
              secondaryContactId: action.secondaryContactId,
              source: mergeSource,
              reasoning: "User approved merge via action swipe",
            }
          );

          if (action.mergeSuggestionId) {
            await ctx.db.patch(action.mergeSuggestionId, {
              status: "approved",
              resolvedAt: now,
            });
          }

          await ctx.db.patch(args.actionId, {
            status: "completed",
            completedAt: now,
          });

          // Decrement counter if was pending
          if (wasPending) {
            await adjustPendingActionCount(ctx, user._id, -1);
          }

          return {
            success: true,
            status: "completed",
            merged: true,
            primaryContactId: action.contactId,
          };
        }

        // Task 8.7: Handle new_connection - save notes to contact
        if (action.type === "new_connection" && action.contactId) {
          // Save responseText as notes on the contact
          if (args.responseText) {
            await ctx.db.patch(action.contactId, {
              notes: args.responseText,
            });
          }

          await ctx.db.patch(args.actionId, {
            status: "completed",
            completedAt: now,
          });

          // Decrement counter if was pending
          if (wasPending) {
            await adjustPendingActionCount(ctx, user._id, -1);
          }

          return {
            success: true,
            status: "completed",
            contactId: action.contactId,
            notesSaved: !!args.responseText,
          };
        }

        // Complete action and potentially send message
        const responseText = args.responseText;

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
        // These platforms have Electron adapters and support undo via the queue
        if (
          (platform === "imessage" || platform === "linkedin" || platform === "slack") &&
          responseText &&
          conversation
        ) {
          // Get recipient info from conversation
          const isGroup =
            conversation.conversationType === "group" ||
            conversation.conversationType === "channel";

          // For groups, we need the chat identifier (from platformConversationId)
          // For 1:1, we need the recipient's handle
          let recipientHandle = "";
          let recipientContactId: Id<"contacts"> | undefined;
          // Slack always needs chatIdentifier (channel ID) for both DMs and channels
          let chatIdentifier: string | undefined;

          if (platform === "slack") {
            // Slack uses platformConversationId (channel ID) for all messages
            chatIdentifier = conversation.platformConversationId;
            // For Slack DMs, get the contact info
            if (!isGroup && conversation.participantContactIds.length > 0) {
              recipientContactId = conversation.participantContactIds[0];
            }
          } else if (!isGroup && conversation.participantContactIds.length > 0) {
            // Get the first participant's handle for 1:1 chats (iMessage/LinkedIn)
            const participantId = conversation.participantContactIds[0];
            recipientContactId = participantId;

            // For iMessage, get the phone/email handle
            // For LinkedIn, the platformConversationId is the thread URN
            if (platform === "imessage") {
              const handleDoc = await ctx.db
                .query("contactHandles")
                .withIndex("by_contact", (q) => q.eq("contactId", participantId))
                .filter((q) => q.eq(q.field("platform"), "imessage"))
                .first();

              if (handleDoc) {
                recipientHandle = handleDoc.handle;
              }
            } else if (platform === "linkedin") {
              // LinkedIn uses platformConversationId (thread URN) as chatIdentifier
              // The LinkedIn adapter expects threadId which maps to chatIdentifier
              chatIdentifier = conversation.platformConversationId;
              recipientHandle = conversation.platformConversationId ?? "";
            }
          } else if (isGroup) {
            // For iMessage groups, use platformConversationId
            // (LinkedIn groups are handled above)
            chatIdentifier = conversation.platformConversationId;
          }

          // Queue message for Electron to send (with undo window based on user settings)
          // Slack: always has chatIdentifier
          // iMessage/LinkedIn: needs recipientHandle for DMs or isGroup for group chats
          if (chatIdentifier || recipientHandle || isGroup) {
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
              actionId: args.actionId,
              workspaceId: conversation.workspaceId,
              status: "pending",
              scheduledFor,
              attempts: 0,
              createdAt: now,
            });

            // Schedule markReady to trigger subscription update when undo window expires
            await ctx.scheduler.runAt(
              scheduledFor,
              internal.messageQueue.markReady,
              { messageId }
            );

            queuedMessageId = messageId;
            messageSent = true;
          }
        }

        // Note: Gmail uses Nango server-side actions (not the message queue)
        // Gmail sending is not yet integrated with the new queue system

        // Mark action as completed
        await ctx.db.patch(args.actionId, {
          status: "completed",
          completedAt: now,
        });

        // Decrement counter if was pending
        if (wasPending) {
          await adjustPendingActionCount(ctx, user._id, -1);
        }

        return {
          success: true,
          status: "completed",
          platform,
          messageSent,
          queuedMessageId,
          responseText,
        };
      }

      default:
        throw new Error(`Unknown swipe direction: ${args.direction}`);
    }
  },
});
