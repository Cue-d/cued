import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import {
  actionStatusValidator,
  actionTypeValidator,
  platformValidator,
} from "./schema";

/**
 * Helper to adjust the pending action count on a user.
 * Call with delta=1 when adding a pending action, delta=-1 when removing.
 */
async function adjustPendingActionCount(
  ctx: MutationCtx,
  userId: Id<"users">,
  delta: number
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;

  const currentCount = user.pendingActionCount ?? 0;
  const newCount = Math.max(0, currentCount + delta);
  await ctx.db.patch(userId, { pendingActionCount: newCount });
}

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

/** Draft option type for enriched action */
interface EnrichedDraftOption {
  text: string;
  label: string;
  confidence: number;
  assumptions: string[];
  styleSources: string[];
  riskFlags: Array<{ type: string; trigger: string }>;
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
  draftResponse: string | null;
  draftOptions: EnrichedDraftOption[] | null;
  selectedOptionIndex: number | null;
  riskLevel: "low" | "medium" | "high" | null;
  riskFlags: string[] | null;
  requiresApproval: boolean | null;
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
    draftResponse: action.draftResponse ?? null,
    draftOptions: action.draftOptions ?? null,
    selectedOptionIndex: action.selectedOptionIndex ?? null,
    riskLevel: action.riskLevel ?? null,
    riskFlags: action.riskFlags ?? null,
    requiresApproval: action.requiresApproval ?? null,
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

/** Validator for draft option risk flags */
const draftOptionRiskFlagValidator = v.object({
  type: v.string(),
  trigger: v.string(),
});

/** Validator for draft options */
const draftOptionValidator = v.object({
  text: v.string(),
  label: v.string(),
  confidence: v.number(),
  assumptions: v.array(v.string()),
  styleSources: v.array(v.string()),
  riskFlags: v.array(draftOptionRiskFlagValidator),
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
    draftResponse: v.optional(v.string()),
    // New multi-option fields
    draftOptions: v.optional(v.array(draftOptionValidator)),
    riskLevel: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high"))
    ),
    riskFlags: v.optional(v.array(v.string())),
    requiresApproval: v.optional(v.boolean()),
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
      draftResponse: args.draftResponse,
      draftOptions: args.draftOptions,
      riskLevel: args.riskLevel,
      riskFlags: args.riskFlags,
      requiresApproval: args.requiresApproval,
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
 * Select a draft option for an action.
 * Populates draftResponse with the selected option's text.
 */
export const selectDraftOption = mutation({
  args: {
    actionId: v.id("actions"),
    optionIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    if (!action.draftOptions || args.optionIndex >= action.draftOptions.length) {
      throw new Error("Invalid option index");
    }

    const selectedOption = action.draftOptions[args.optionIndex];

    await ctx.db.patch(args.actionId, {
      selectedOptionIndex: args.optionIndex,
      draftResponse: selectedOption.text,
    });

    return { success: true, selectedText: selectedOption.text };
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
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 20, 100);

    const actionable = await fetchActionableActions(ctx, user._id);

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
        draftResponse: action.draftResponse ?? null,
        draftOptions: action.draftOptions ?? null,
        selectedOptionIndex: action.selectedOptionIndex ?? null,
        riskLevel: action.riskLevel ?? null,
        riskFlags: action.riskFlags ?? null,
        requiresApproval: action.requiresApproval ?? null,
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
          let mergeSource: "email_match" | "phone_match" = "email_match";
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
            draftResponse: args.responseText,
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
        // Get the response text (user-edited draft or first draft option)
        const responseText =
          args.responseText ?? action.draftResponse ?? action.draftOptions?.[0]?.text;

        // Get conversation to determine platform
        const conversation = action.conversationId
          ? await ctx.db.get(action.conversationId)
          : null;
        const platform = action.platform ?? conversation?.platform;

        let messageSent = false;
        let pendingSendId: string | null = null;

        // Handle iMessage sending via pending sends queue (Electron polls this)
        if (platform === "imessage" && responseText && conversation) {
          // Get recipient info from conversation
          const isGroup = conversation.conversationType === "group";

          // For groups, we need the chat identifier (from platformConversationId)
          // For 1:1, we need the recipient's handle
          let recipientHandle = "";

          if (!isGroup && conversation.participantContactIds.length > 0) {
            // Get the first participant's handle for 1:1 chats
            const participantId = conversation.participantContactIds[0];
            const handles = await ctx.db
              .query("contactHandles")
              .withIndex("by_contact", (q) => q.eq("contactId", participantId))
              .filter((q) => q.eq(q.field("platform"), "imessage"))
              .first();

            if (handles) {
              recipientHandle = handles.handle;
            }
          }

          // Create pending send for Electron to pick up
          if (recipientHandle || isGroup) {
            // const sendId = await ctx.db.insert("pendingSends", {
            //   userId: user._id,
            //   conversationId: conversation._id,
            //   actionId: args.actionId,
            //   text: responseText,
            //   recipientHandle: recipientHandle,
            //   isGroup,
            //   chatIdentifier: isGroup ? conversation.platformConversationId : undefined,
            //   status: "pending",
            //   createdAt: now,
            //   attempts: 0,
            // });
            const sendId = null;
            pendingSendId = sendId;
            messageSent = true;
          }
        }

        // Handle Gmail sending via Nango action
        if (platform === "gmail" && responseText && conversation) {
          // Get user's Gmail integration
          const integration = await ctx.db
            .query("integrations")
            .withIndex("by_user_platform", (q) =>
              q.eq("userId", user._id).eq("platform", "gmail")
            )
            .first();

          if (integration?.nangoConnectionId) {
            // Get recipient email from conversation participants
            let recipientEmail = "";
            if (conversation.participantContactIds.length > 0) {
              const participantId = conversation.participantContactIds[0];
              const emailHandle = await ctx.db
                .query("contactHandles")
                .withIndex("by_contact", (q) => q.eq("contactId", participantId))
                .filter((q) => q.eq(q.field("handleType"), "email"))
                .first();

              if (emailHandle) {
                recipientEmail = emailHandle.handle;
              }
            }

            if (recipientEmail) {
              // Schedule Gmail send action
              await ctx.scheduler.runAfter(
                0,
                internal.emailSender.sendGmailEmail,
                {
                  connectionId: integration.nangoConnectionId,
                  to: recipientEmail,
                  subject: `Re: ${conversation.displayName ?? "Message"}`,
                  body: responseText,
                  threadId: conversation.platformConversationId,
                  actionId: args.actionId,
                  conversationId: conversation._id,
                }
              );
              messageSent = true;
            }
          }
        }

        // Mark action as completed
        await ctx.db.patch(args.actionId, {
          status: "completed",
          completedAt: now,
          draftResponse: responseText,
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
          pendingSendId,
          responseText,
        };
      }

      default:
        throw new Error(`Unknown swipe direction: ${args.direction}`);
    }
  },
});

/**
 * Update draft response while user is typing.
 * This saves typing progress so it persists across sessions.
 */
export const updateDraftResponse = mutation({
  args: {
    actionId: v.id("actions"),
    draftResponse: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    await ctx.db.patch(args.actionId, {
      draftResponse: args.draftResponse,
    });

    return { success: true };
  },
});

// ============================================================================
// Style profile extraction
// ============================================================================

/** Supported platforms for style profiles */
type StylePlatform = "imessage" | "gmail" | "slack";
const STYLE_PLATFORMS: readonly StylePlatform[] = ["imessage", "gmail", "slack"];

/** Platform type validator for style profiles */
const stylePlatformValidator = v.union(
  v.literal("imessage"),
  v.literal("gmail"),
  v.literal("slack")
);

/** Check if a platform supports style profiles */
function isStylePlatform(platform: string): platform is StylePlatform {
  return STYLE_PLATFORMS.includes(platform as StylePlatform);
}

/** Get user's sent messages for style extraction */
export const getMessagesForStyleExtraction = query({
  args: {
    platform: stylePlatformValidator,
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { messages: [], count: 0 };

    const limit = Math.min(args.limit ?? 200, 500);

    // Get user's sent messages for the platform
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_user_sent_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit * 3); // Take more to filter

    const platformMessages = allMessages
      .filter((m) => m.isFromMe && m.platform === args.platform)
      .slice(0, limit);

    // Get conversation info for recipient names
    const convoIds = [...new Set(platformMessages.map((m) => m.conversationId))];
    const convos = await Promise.all(convoIds.map((id) => ctx.db.get(id)));
    const convoMap = new Map(convos.filter(Boolean).map((c) => [c!._id, c!]));

    const messages = await Promise.all(
      platformMessages.map(async (msg) => {
        const convo = convoMap.get(msg.conversationId);
        let recipientName: string | undefined;
        if (convo && convo.participantContactIds.length > 0) {
          const recipient = await ctx.db.get(convo.participantContactIds[0]);
          recipientName = recipient?.displayName;
        }
        return {
          content: msg.content,
          platform: msg.platform as StylePlatform,
          sentAt: msg.sentAt,
          recipientName,
        };
      })
    );

    return { messages, count: messages.length };
  },
});

/** Save extracted style profile */
export const saveStyleProfile = internalMutation({
  args: {
    userId: v.id("users"),
    platform: stylePlatformValidator,
    profile: v.object({
      greetingStyle: v.string(),
      signOffStyle: v.string(),
      avgLength: v.number(),
      emojiFrequency: v.number(),
      formalityScore: v.number(),
      brevityScore: v.number(),
      hedgingPatterns: v.array(v.string()),
      punctuationNotes: v.string(),
    }),
    sampleCount: v.number(),
  },
  handler: async (ctx, args) => {
    // Check for existing profile
    const existing = await ctx.db
      .query("userStyleProfiles")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", args.userId).eq("platform", args.platform)
      )
      .first();

    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        profile: args.profile,
        extractedAt: Date.now(),
        sampleCount: args.sampleCount,
      });
      return { profileId: existing._id, updated: true };
    }

    // Create new
    const profileId = await ctx.db.insert("userStyleProfiles", {
      userId: args.userId,
      platform: args.platform,
      profile: args.profile,
      extractedAt: Date.now(),
      sampleCount: args.sampleCount,
    });

    return { profileId, updated: false };
  },
});

/**
 * Extract style profile from user's sent messages.
 * This is a Convex action because it calls external APIs (OpenAI).
 */
export const extractStyleProfile = action({
  args: {
    platform: stylePlatformValidator,
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    profile?: {
      greetingStyle: string;
      signOffStyle: string;
      avgLength: number;
      emojiFrequency: number;
      formalityScore: number;
      brevityScore: number;
      hedgingPatterns: string[];
      punctuationNotes: string;
    };
    sampleCount?: number;
    error?: string;
  }> => {
    // Get current user ID
    const userId = await ctx.runQuery(api.actions.getCurrentUserId, {});
    if (!userId) {
      return { success: false, error: "Not authenticated" };
    }

    // Get messages for extraction
    const { messages, count } = await ctx.runQuery(
      api.actions.getMessagesForStyleExtraction,
      { platform: args.platform, limit: 200 }
    );

    if (count < 10) {
      return {
        success: false,
        error: `Not enough messages for ${args.platform}. Found ${count}, need at least 10.`,
      };
    }

    try {
      // Import style extraction function
      const { extractStyleProfile: extractStyle } = await import("@prm/ai");

      // Extract style profile
      const profile = await extractStyle(messages, args.platform);

      // Save to database
      await ctx.runMutation(internal.actions.saveStyleProfile, {
        userId,
        platform: args.platform,
        profile,
        sampleCount: count,
      });

      return {
        success: true,
        profile,
        sampleCount: count,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Style extraction failed:", errorMessage);
      return { success: false, error: errorMessage };
    }
  },
});

/** Get current user's style profile */
export const getStyleProfile = query({
  args: {
    platform: stylePlatformValidator,
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const profile = await ctx.db
      .query("userStyleProfiles")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .first();

    return profile;
  },
});

/** Get all style profiles for the current user */
export const getAllStyleProfiles = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return [];

    const profiles = await ctx.db
      .query("userStyleProfiles")
      .withIndex("by_user_platform", (q) => q.eq("userId", user._id))
      .collect();

    return profiles;
  },
});

/** Get current user ID (for actions that need to save data) */
export const getCurrentUserId = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    return user?._id ?? null;
  },
});

// ============================================================================
// On-demand draft generation
// ============================================================================

/** Internal query to get context needed for draft generation */
export const getDraftGenerationContext = query({
  args: {
    actionId: v.id("actions"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) return null;

    const conversation = action.conversationId
      ? await ctx.db.get(action.conversationId)
      : null;
    if (!conversation) return null;

    const contact = action.contactId
      ? await ctx.db.get(action.contactId)
      : null;

    // Get recent messages (last 15 for context), then reverse to chronological
    const rawMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversation._id)
      )
      .order("desc")
      .take(15);
    rawMessages.reverse();

    // Enrich messages with sender names
    const messages = await Promise.all(
      rawMessages.map(async (msg) => {
        const senderName = msg.senderContactId
          ? (await ctx.db.get(msg.senderContactId))?.displayName
          : undefined;
        return {
          content: msg.content,
          isFromMe: msg.isFromMe,
          sentAt: msg.sentAt,
          senderName,
        };
      })
    );

    // Get style profile if platform supports it
    const styleProfile = isStylePlatform(conversation.platform)
      ? await ctx.db
          .query("userStyleProfiles")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", user._id).eq("platform", conversation.platform as StylePlatform)
          )
          .first()
      : null;

    // Get user's sent messages for similar reply retrieval
    const allRecentMessages = await ctx.db
      .query("messages")
      .withIndex("by_user_sent_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(300);

    const userSentMessages = allRecentMessages
      .filter((m) => m.isFromMe)
      .slice(0, 100);

    // Build conversation lookup for recipient names
    const convoIds = [...new Set(userSentMessages.map((m) => m.conversationId))];
    const convos = await Promise.all(convoIds.map((id) => ctx.db.get(id)));
    const convoMap = new Map(convos.filter(Boolean).map((c) => [c!._id, c!]));

    // Map to searchable message format
    const sentMessagesForSearch = await Promise.all(
      userSentMessages.map(async (msg) => {
        const convo = convoMap.get(msg.conversationId);
        const recipientName = convo?.participantContactIds[0]
          ? (await ctx.db.get(convo.participantContactIds[0]))?.displayName
          : undefined;

        return {
          _id: msg._id.toString(),
          content: msg.content,
          sentAt: msg.sentAt,
          platform: isStylePlatform(msg.platform) ? msg.platform : "imessage" as const,
          isFromMe: msg.isFromMe,
          conversationId: msg.conversationId.toString(),
          recipientName,
        };
      })
    );

    // Calculate hours since last message
    const lastMessage = messages[messages.length - 1];
    const hoursSinceLastMessage = lastMessage
      ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
      : 0;

    const contactInfo = contact
      ? {
          displayName: contact.displayName,
          company: contact.company ?? undefined,
          notes: contact.notes ?? undefined,
          isKnownContact: true as const,
          tags: contact.tags ?? undefined,
          importance: contact.importance ?? undefined,
          styleOverrides: contact.styleOverrides ?? undefined,
        }
      : {
          displayName: "Unknown",
          isKnownContact: false as const,
        };

    return {
      action: {
        _id: action._id,
        type: action.type,
        priority: action.priority,
      },
      contact: contactInfo,
      messages,
      platform: conversation.platform,
      hoursSinceLastMessage,
      styleProfile: styleProfile?.profile ?? null,
      sentMessagesForSearch,
    };
  },
});

/** Internal mutation to save generated draft options */
export const saveDraftOptions = internalMutation({
  args: {
    actionId: v.id("actions"),
    draftOptions: v.array(draftOptionValidator),
    riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    riskFlags: v.array(v.string()),
    requiresApproval: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionId, {
      draftOptions: args.draftOptions,
      riskLevel: args.riskLevel,
      riskFlags: args.riskFlags,
      requiresApproval: args.requiresApproval,
      // Set first option as default draft response
      draftResponse: args.draftOptions[0]?.text ?? null,
      selectedOptionIndex: 0,
    });
    return { success: true };
  },
});

/** Map any platform to a style platform (defaulting to gmail for unsupported) */
function toStylePlatform(platform: string): StylePlatform {
  return isStylePlatform(platform) ? platform : "gmail";
}

/**
 * Generate draft response options for an action on-demand.
 * This is a Convex action because it calls external APIs (OpenAI).
 */
export const generateDraftOptions = action({
  args: {
    actionId: v.id("actions"),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    draftOptions?: Array<{
      text: string;
      label: string;
      confidence: number;
      assumptions: string[];
      styleSources: string[];
      riskFlags: Array<{ type: string; trigger: string }>;
    }>;
    riskLevel?: "low" | "medium" | "high";
    error?: string;
  }> => {
    const context = await ctx.runQuery(api.actions.getDraftGenerationContext, {
      actionId: args.actionId,
    });

    if (!context) {
      return { success: false, error: "Action not found or no conversation context" };
    }

    try {
      const { generateActionWithOptionsRetry, retrieveSimilarReplies } =
        await import("@prm/ai");

      // Find the last incoming message for similar reply matching
      const incomingMessage = context.messages
        .slice()
        .reverse()
        .find((m) => !m.isFromMe);

      const stylePlatform = toStylePlatform(context.platform);

      // Retrieve similar past replies for style matching
      const similarReplies = incomingMessage
        ? await retrieveSimilarReplies(
            incomingMessage.content,
            context.sentMessagesForSearch,
            {
              conversationId: context.action._id.toString(),
              contactName: context.contact.displayName,
              platform: stylePlatform,
            },
            3
          )
        : [];

      const result = await generateActionWithOptionsRetry({
        contact: context.contact,
        messages: context.messages,
        platform: context.platform as "imessage" | "gmail" | "slack" | "linkedin" | "twitter",
        hoursSinceLastMessage: context.hoursSinceLastMessage,
        styleProfile: context.styleProfile ?? undefined,
        styleOverrides: context.contact.styleOverrides,
        similarReplies,
      });

      if (!result.draftOptions || result.draftOptions.length === 0) {
        return { success: false, error: "No draft options generated" };
      }

      await ctx.runMutation(internal.actions.saveDraftOptions, {
        actionId: args.actionId,
        draftOptions: result.draftOptions,
        riskLevel: result.riskLevel,
        riskFlags: result.draftOptions.flatMap((opt) =>
          opt.riskFlags.map((f) => `${f.type}: ${f.trigger}`)
        ),
        requiresApproval: result.requiresApproval,
      });

      return {
        success: true,
        draftOptions: result.draftOptions,
        riskLevel: result.riskLevel,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Draft generation failed:", errorMessage);
      return { success: false, error: errorMessage };
    }
  },
});
