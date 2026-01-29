"use node";
/**
 * Resolve contact action handler.
 * Handles merging duplicate contacts.
 */

import { internal } from "../_generated/api";
import type {
  ActionSwipeHandler,
  SwipeHandlerContext,
  SwipeHandlerResult,
} from "./types";

export const resolveContactHandler: ActionSwipeHandler = {
  async onSwipeRight({
    ctx,
    action,
    now,
  }: SwipeHandlerContext): Promise<SwipeHandlerResult> {
    if (!action.contactId || !action.secondaryContactId) {
      throw new Error("resolve_contact action missing contact IDs");
    }

    // Get merge source from suggestion if available
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

    // Schedule merge operation
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

    // Update merge suggestion status
    if (action.mergeSuggestionId) {
      await ctx.db.patch(action.mergeSuggestionId, {
        status: "approved",
        resolvedAt: now,
      });
    }

    return {
      success: true,
      status: "completed",
      data: {
        merged: true,
        primaryContactId: action.contactId,
      },
    };
  },

  async onSwipeLeft({
    ctx,
    action,
    now,
  }: SwipeHandlerContext): Promise<SwipeHandlerResult> {
    // Reject the merge suggestion
    if (action.mergeSuggestionId) {
      await ctx.db.patch(action.mergeSuggestionId, {
        status: "rejected",
        resolvedAt: now,
      });
    }

    return {
      success: true,
      status: "discarded",
    };
  },
};
