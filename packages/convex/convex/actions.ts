import { v } from "convex/values";
import type { EnrichedAction } from "@cued/shared";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import { adjustPendingActionCount } from "./lib/actions";
import { resolveActionSummary } from "./lib/actionSummary";
import {
  actionStatusValidator,
  actionTypeValidator,
  platformValidator,
} from "./schema";
import {
  getQueuedMessagesForConversation,
  mapQueueToDisplayMessage,
} from "./lib/queueMerge";
import { executeSwipeHandler } from "./swipeHandlers/registry";
import {
  groupReactions,
  collectReactionContactIds,
  type ReactionGroupResult,
} from "./lib/reactions";

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

interface ActionEnrichmentCache {
  conversations: Map<string, Doc<"conversations">>;
  contacts: Map<string, Doc<"contacts">>;
}

async function buildActionEnrichmentCache(
  ctx: QueryCtx,
  actions: Doc<"actions">[]
): Promise<ActionEnrichmentCache> {
  const conversationIds = [
    ...new Set(
      actions
        .map((action) => action.conversationId)
        .filter((id): id is Id<"conversations"> => id !== undefined)
    ),
  ];
  const conversations = await Promise.all(
    conversationIds.map((id) => ctx.db.get(id))
  );
  const conversationMap = new Map(
    conversationIds
      .map((id, i) => [id as string, conversations[i]])
      .filter(
        (entry): entry is [string, Doc<"conversations">] =>
          entry[1] !== null
      )
  );

  const contactIds = new Set<Id<"contacts">>();
  for (const action of actions) {
    if (action.contactId) {
      contactIds.add(action.contactId);
    }
    if (action.secondaryContactId) {
      contactIds.add(action.secondaryContactId);
    }
  }

  for (const conversation of conversationMap.values()) {
    if (
      conversation.conversationType === "group" ||
      conversation.conversationType === "channel"
    ) {
      for (const participantId of conversation.participantContactIds) {
        contactIds.add(participantId);
      }
    }
  }

  const contactIdList = [...contactIds];
  const contacts = await Promise.all(contactIdList.map((id) => ctx.db.get(id)));
  const contactMap = new Map(
    contactIdList
      .map((id, i) => [id as string, contacts[i]])
      .filter(
        (entry): entry is [string, Doc<"contacts">] =>
          entry[1] !== null
      )
  );

  return {
    conversations: conversationMap,
    contacts: contactMap,
  };
}

/** Enrich an action with related contact and conversation data. */
function enrichAction(
  action: Doc<"actions">,
  cache: ActionEnrichmentCache
): EnrichedAction {
  const conversation = action.conversationId
    ? cache.conversations.get(action.conversationId as string) ?? null
    : null;
  const contact = action.contactId
    ? cache.contacts.get(action.contactId as string) ?? null
    : null;
  const secondaryContact = action.secondaryContactId
    ? cache.contacts.get(action.secondaryContactId as string) ?? null
    : null;

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
      const names = conversation.participantContactIds
        .map((id) => cache.contacts.get(id as string))
        .filter((participant): participant is Doc<"contacts"> => participant !== undefined)
        .map((participant) => participant.displayName)
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
    summary: action.summary ?? resolveActionSummary(action.type),
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
    mergeConfidence: action.mergeConfidence ?? null,
    mergeSource: action.mergeSource ?? null,
    mergeReasoning: action.mergeReasoning ?? null,
    platform,
  };
}

async function enrichActions(
  ctx: QueryCtx,
  actions: Doc<"actions">[]
): Promise<EnrichedAction[]> {
  if (actions.length === 0) return [];
  const cache = await buildActionEnrichmentCache(ctx, actions);
  return actions.map((action) => enrichAction(action, cache));
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

    const limit = Math.min(args.limit ?? 20, 500);

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

    const enriched = await enrichActions(ctx, actions);
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
    summary: v.optional(v.string()),
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
      summary: resolveActionSummary(args.type, args.summary),
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

    const limit = Math.min(args.limit ?? 20, 500);

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

    const enriched = await enrichActions(ctx, actions);

    const nextCursor =
      hasMore && actions.length > 0
        ? actions[actions.length - 1].createdAt
        : null;

    return { actions: enriched, nextCursor };
  },
});

/**
 * Fetch completed and discarded actions for history view.
 * Returns enriched actions sorted by resolution timestamp (most recent first).
 */
const actionHistoryCursorValidator = v.object({
  resolvedAt: v.number(),
  actionId: v.id("actions"),
});

type ActionHistoryCursor = {
  resolvedAt: number;
  actionId: Id<"actions">;
};

const MAX_HISTORY_SCAN_PER_STATUS = 2000;

function getActionResolvedAt(action: Pick<Doc<"actions">, "completedAt" | "discardedAt" | "createdAt">): number {
  return action.completedAt ?? action.discardedAt ?? action.createdAt;
}

function compareHistoryActions(a: Doc<"actions">, b: Doc<"actions">): number {
  const aTime = getActionResolvedAt(a);
  const bTime = getActionResolvedAt(b);
  if (bTime !== aTime) return bTime - aTime;
  return String(b._id).localeCompare(String(a._id));
}

function isAfterCursor(action: Doc<"actions">, cursor: ActionHistoryCursor): boolean {
  const resolvedAt = getActionResolvedAt(action);
  if (resolvedAt < cursor.resolvedAt) return true;
  if (resolvedAt > cursor.resolvedAt) return false;
  return String(action._id).localeCompare(String(cursor.actionId)) < 0;
}

async function loadHistoryCandidatesForStatus(
  ctx: QueryCtx,
  userId: Id<"users">,
  status: "completed" | "discarded",
  cursor: number | ActionHistoryCursor | undefined,
  take: number
): Promise<Doc<"actions">[]> {
  if (status === "completed") {
    const queryBuilder = ctx.db.query("actions").withIndex("by_user_status_completed_at", (q) => {
      const base = q.eq("userId", userId).eq("status", "completed");
      if (cursor === undefined) return base;
      // Legacy timestamp cursor has no tie-breaker; strict < avoids page-boundary duplicates.
      if (typeof cursor === "number") return base.lt("completedAt", cursor);
      return base.lte("completedAt", cursor.resolvedAt);
    });
    return queryBuilder.order("desc").take(take);
  }

  const queryBuilder = ctx.db.query("actions").withIndex("by_user_status_discarded_at", (q) => {
    const base = q.eq("userId", userId).eq("status", "discarded");
    if (cursor === undefined) return base;
    // Legacy timestamp cursor has no tie-breaker; strict < avoids page-boundary duplicates.
    if (typeof cursor === "number") return base.lt("discardedAt", cursor);
    return base.lte("discardedAt", cursor.resolvedAt);
  });
  return queryBuilder.order("desc").take(take);
}

export const getActionHistory = query({
  args: {
    limit: v.optional(v.number()),
    // Backward-compatible: accepts legacy timestamp cursor and object cursor with tie-breaker.
    cursor: v.optional(v.union(v.number(), actionHistoryCursorValidator)),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 25, 500);
    let scanLimit = Math.min(limit + 1, MAX_HISTORY_SCAN_PER_STATUS);
    let merged: Doc<"actions">[] = [];

    while (true) {
      const [completedActions, discardedActions] = await Promise.all([
        loadHistoryCandidatesForStatus(
          ctx,
          user._id,
          "completed",
          args.cursor as number | ActionHistoryCursor | undefined,
          scanLimit
        ),
        loadHistoryCandidatesForStatus(
          ctx,
          user._id,
          "discarded",
          args.cursor as number | ActionHistoryCursor | undefined,
          scanLimit
        ),
      ]);

      merged = [...completedActions, ...discardedActions];

      // For object cursors, range queries include same-timestamp rows and we trim
      // to strict "after cursor" ordering with the _id tie-breaker.
      if (args.cursor && typeof args.cursor !== "number") {
        const cursor: ActionHistoryCursor = args.cursor;
        merged = merged.filter((action) => isAfterCursor(action, cursor));
      }

      merged.sort(compareHistoryActions);

      const exhausted =
        completedActions.length < scanLimit && discardedActions.length < scanLimit;
      if (
        merged.length >= limit + 1 ||
        exhausted ||
        scanLimit >= MAX_HISTORY_SCAN_PER_STATUS
      ) {
        break;
      }

      scanLimit = Math.min(scanLimit * 2, MAX_HISTORY_SCAN_PER_STATUS);
    }

    // Take limit + 1 to determine if there's more
    const page = merged.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const actions = hasMore ? page.slice(0, limit) : page;

    const enriched = await enrichActions(ctx, actions);

    const lastAction = actions[actions.length - 1];
    const nextCursor =
      hasMore && lastAction
        ? {
            resolvedAt: getActionResolvedAt(lastAction),
            actionId: lastAction._id,
          }
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

    // Resolve conversation participants with their platforms
    const participantContactIds = conversation?.participantContactIds ?? [];
    const participantContacts = await Promise.all(
      participantContactIds.map((id) => ctx.db.get(id))
    );
    const participantHandles = await Promise.all(
      participantContactIds.map((id) =>
        ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", id))
          .collect()
      )
    );
    const participants = participantContacts
      .map((c, i) => {
        if (!c) return null;
        const platforms = [
          ...new Set(participantHandles[i].map((h) => h.platform)),
        ];
        return { _id: c._id, displayName: c.displayName, platforms };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

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

    type ActionContextMessage = {
      _id: Id<"messages">;
      content: string;
      sentAt: number;
      isFromMe: boolean;
      senderName: string | null;
      senderContactId: Id<"contacts"> | null;
      status?: string | null;
      reactions: ReactionGroupResult[] | null;
    };

    // Batch resolve sender + reaction contacts
    const senderIds = [
      ...new Set(
        messages
          .map((m) => m.senderContactId)
          .filter((id): id is Id<"contacts"> => id !== undefined)
      ),
    ];
    const reactionContactIds = collectReactionContactIds(messages);
    const allContactIds = [
      ...new Set([...senderIds, ...reactionContactIds].map(String)),
    ] as Id<"contacts">[];
    const allContacts = await Promise.all(
      allContactIds.map((id) => ctx.db.get(id))
    );
    const contactNameMap = new Map<string, string>();
    for (let i = 0; i < allContactIds.length; i++) {
      const contact = allContacts[i];
      if (contact) contactNameMap.set(allContactIds[i] as string, contact.displayName);
    }

    const messagesWithSender: ActionContextMessage[] = messages.map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content == null
            ? ""
            : String(msg.content);
      const sentAt =
        typeof msg.sentAt === "number" && Number.isFinite(msg.sentAt)
          ? msg.sentAt
          : 0;

      let senderName: string | null = null;
      if (msg.isFromMe) {
        senderName = "You";
      } else if (msg.senderContactId) {
        senderName = contactNameMap.get(msg.senderContactId as string) ?? null;
      }

      return {
        _id: msg._id,
        content,
        sentAt,
        isFromMe: msg.isFromMe,
        senderName,
        senderContactId: msg.senderContactId ?? null,
        status: msg.status,
        reactions: groupReactions(msg.reactions, contactNameMap),
      };
    });

    // Merge queued messages for this conversation
    if (action.conversationId) {
      const queued = await getQueuedMessagesForConversation(
        ctx,
        user._id,
        action.conversationId
      );
      messagesWithSender.push(...queued.map(mapQueueToDisplayMessage));
    }

    // Reverse to show oldest first (chronological order for display)
    messagesWithSender.reverse();

    return {
      action: {
        _id: action._id,
        type: action.type,
        status: action.status,
        priority: action.priority,
        summary: action.summary ?? resolveActionSummary(action.type),
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
            platformConversationId: conversation.platformConversationId,
            conversationType: conversation.conversationType,
            displayName: conversation.displayName ?? null,
            lastMessageAt: conversation.lastMessageAt ?? null,
            workspaceId: conversation.workspaceId ?? null,
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
      participants,
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
 * Uses the action handler registry to dispatch to the appropriate handler.
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

    // Execute the handler for this action type
    const result = await executeSwipeHandler(
      action.type,
      args.direction,
      { ctx, user, action, now },
      { responseText: args.responseText, snoozedUntil: args.snoozedUntil }
    );

    // Update action status based on handler result
    const updates: Partial<Doc<"actions">> = { status: result.status };
    if (result.status === "completed") {
      updates.completedAt = now;
    } else if (result.status === "discarded") {
      updates.discardedAt = now;
    } else if (result.status === "snoozed" && args.snoozedUntil) {
      updates.snoozedUntil = args.snoozedUntil;
    }
    await ctx.db.patch(args.actionId, updates);

    // Adjust pending action count if was pending (handlers always return non-pending status)
    if (wasPending) {
      await adjustPendingActionCount(ctx, user._id, -1);
    }

    // Build return with explicit optional fields for TypeScript
    const response: {
      success: boolean;
      status: "completed" | "discarded" | "snoozed";
      [key: string]: unknown;
    } = {
      success: result.success,
      status: result.status,
      ...result.data,
    };

    return response;
  },
});

/**
 * Discard multiple actions in a single mutation.
 * Used by multi-select UI to apply one atomic update instead of many requests.
 */
export const discardActionsBulk = mutation({
  args: {
    actionIds: v.array(v.id("actions")),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const now = Date.now();

    const actionIds = [...new Set(args.actionIds)] as Id<"actions">[];
    if (actionIds.length === 0) {
      return { success: true, discardedCount: 0, pendingDiscardedCount: 0 };
    }

    const actions = await Promise.all(actionIds.map((actionId) => ctx.db.get(actionId)));

    // Validate ownership up front so the mutation is all-or-nothing.
    for (const action of actions) {
      if (!action || action.userId !== user._id) {
        throw new Error("Action not found");
      }
    }

    let pendingDiscardedCount = 0;

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const actionId = actionIds[i];
      if (!action) continue;

      const result = await executeSwipeHandler(
        action.type,
        "left",
        { ctx, user, action, now }
      );

      if (result.status !== "discarded") {
        throw new Error(
          `Left swipe returned unexpected status '${result.status}' for action type '${action.type}'`
        );
      }

      await ctx.db.patch(actionId, {
        status: "discarded",
        discardedAt: now,
      });

      if (action.status === "pending") {
        pendingDiscardedCount += 1;
      }
    }

    if (pendingDiscardedCount > 0) {
      await adjustPendingActionCount(ctx, user._id, -pendingDiscardedCount);
    }

    return {
      success: true,
      discardedCount: actionIds.length,
      pendingDiscardedCount,
    };
  },
});
