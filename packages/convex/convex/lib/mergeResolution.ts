import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

interface ResolveStaleMergeSuggestionsResult {
  affectedSuggestionIds: Set<Id<"mergeSuggestions">>;
  pairSuggestionIds: Set<Id<"mergeSuggestions">>;
}

interface ResolveStaleActionsForMergeResult {
  resolvedPendingActionCount: number;
  affectedActionIds: Set<Id<"actions">>;
}

export interface ResolveMergeArtifactsForContactMergeResult {
  affectedSuggestionIds: Set<Id<"mergeSuggestions">>;
  pairSuggestionIds: Set<Id<"mergeSuggestions">>;
  resolvedPendingActionCount: number;
  affectedActionIds: Id<"actions">[];
}

/**
 * Resolve pending merge suggestions that reference the secondary contact.
 * Approves the suggestion for the primary-secondary pair, rejects others.
 */
export async function resolveStaleMergeSuggestions(
  ctx: MutationCtx,
  userId: Id<"users">,
  primaryContactId: Id<"contacts">,
  secondaryContactId: Id<"contacts">,
  now: number,
): Promise<ResolveStaleMergeSuggestionsResult> {
  const pendingSuggestions = await ctx.db
    .query("mergeSuggestions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .collect();

  const affectedSuggestionIds = new Set<Id<"mergeSuggestions">>();
  const pairSuggestionIds = new Set<Id<"mergeSuggestions">>();

  for (const suggestion of pendingSuggestions) {
    const touchesSecondary =
      suggestion.contact1Id === secondaryContactId ||
      suggestion.contact2Id === secondaryContactId;
    if (!touchesSecondary) continue;

    const isThisMergePair =
      (suggestion.contact1Id === primaryContactId &&
        suggestion.contact2Id === secondaryContactId) ||
      (suggestion.contact1Id === secondaryContactId &&
        suggestion.contact2Id === primaryContactId);

    await ctx.db.patch(suggestion._id, {
      status: isThisMergePair ? "approved" : "rejected",
      resolvedAt: now,
    });

    affectedSuggestionIds.add(suggestion._id);
    if (isThisMergePair) pairSuggestionIds.add(suggestion._id);
  }

  return { affectedSuggestionIds, pairSuggestionIds };
}

/**
 * Rewrite or resolve actions that reference the secondary contact.
 *
 * 1. Actions whose primary `contactId` is secondary are repointed, except
 *    pending resolve_contact actions which are resolved.
 * 2. Remaining pending resolve_contact actions that reference secondary via
 *    `secondaryContactId` or affected `mergeSuggestionId` are resolved.
 */
export async function resolveStaleActionsForMerge(
  ctx: MutationCtx,
  userId: Id<"users">,
  primaryContactId: Id<"contacts">,
  secondaryContactId: Id<"contacts">,
  pairSuggestionIds: Set<Id<"mergeSuggestions">>,
  affectedSuggestionIds: Set<Id<"mergeSuggestions">>,
  now: number,
): Promise<ResolveStaleActionsForMergeResult> {
  let resolvedPendingActionCount = 0;
  const affectedActionIds = new Set<Id<"actions">>();

  const actionsBySecondary = await ctx.db
    .query("actions")
    .withIndex("by_contact", (q) => q.eq("contactId", secondaryContactId))
    .collect();

  const handledActionIds = new Set<Id<"actions">>();

  for (const action of actionsBySecondary) {
    if (action.type === "resolve_contact" && action.status === "pending") {
      const isThisMergePair =
        action.secondaryContactId === primaryContactId ||
        (!!action.mergeSuggestionId &&
          pairSuggestionIds.has(action.mergeSuggestionId));

      await ctx.db.patch(
        action._id,
        isThisMergePair
          ? { status: "completed", completedAt: now }
          : { status: "discarded", discardedAt: now },
      );
      resolvedPendingActionCount++;
      handledActionIds.add(action._id);
      affectedActionIds.add(action._id);
      continue;
    }

    await ctx.db.patch(action._id, { contactId: primaryContactId });
    affectedActionIds.add(action._id);
  }

  const pendingResolveActions = await ctx.db
    .query("actions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .filter((q) => q.eq(q.field("type"), "resolve_contact"))
    .collect();

  for (const action of pendingResolveActions) {
    if (handledActionIds.has(action._id)) continue;

    const touchesSecondary =
      action.contactId === secondaryContactId ||
      action.secondaryContactId === secondaryContactId ||
      (!!action.mergeSuggestionId &&
        affectedSuggestionIds.has(action.mergeSuggestionId));
    if (!touchesSecondary) continue;

    const isThisMergePair =
      (action.contactId === primaryContactId &&
        action.secondaryContactId === secondaryContactId) ||
      (action.contactId === secondaryContactId &&
        action.secondaryContactId === primaryContactId) ||
      (!!action.mergeSuggestionId &&
        pairSuggestionIds.has(action.mergeSuggestionId));

    await ctx.db.patch(
      action._id,
      isThisMergePair
        ? { status: "completed", completedAt: now }
        : { status: "discarded", discardedAt: now },
    );
    resolvedPendingActionCount++;
    affectedActionIds.add(action._id);
  }

  return { resolvedPendingActionCount, affectedActionIds };
}

/**
 * Resolve stale merge suggestions/actions and update pendingActionCount.
 */
export async function resolveMergeArtifactsForContactMerge(
  ctx: MutationCtx,
  userId: Id<"users">,
  primaryContactId: Id<"contacts">,
  secondaryContactId: Id<"contacts">,
  now: number,
): Promise<ResolveMergeArtifactsForContactMergeResult> {
  const { affectedSuggestionIds, pairSuggestionIds } =
    await resolveStaleMergeSuggestions(
      ctx,
      userId,
      primaryContactId,
      secondaryContactId,
      now,
    );

  const { resolvedPendingActionCount, affectedActionIds } =
    await resolveStaleActionsForMerge(
      ctx,
      userId,
      primaryContactId,
      secondaryContactId,
      pairSuggestionIds,
      affectedSuggestionIds,
      now,
    );

  if (resolvedPendingActionCount > 0) {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        pendingActionCount: Math.max(
          0,
          (user.pendingActionCount ?? 0) - resolvedPendingActionCount,
        ),
      });
    }
  }

  return {
    affectedSuggestionIds,
    pairSuggestionIds,
    resolvedPendingActionCount,
    affectedActionIds: [...affectedActionIds],
  };
}
