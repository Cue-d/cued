/**
 * End of Day contact action handler.
 * Handles reviewing/updating contact info at end of day.
 */

import type {
  ActionSwipeHandler,
  SwipeHandlerContext,
  SwipeHandlerResult,
  RightSwipeInput,
} from "./types";

export const eodContactHandler: ActionSwipeHandler = {
  async onSwipeRight(
    { ctx, action }: SwipeHandlerContext,
    input?: RightSwipeInput
  ): Promise<SwipeHandlerResult> {
    // Validate contactId exists
    if (!action.contactId) {
      throw new Error(
        "Cannot complete EOD contact action: no contact associated with action."
      );
    }

    // Save notes if provided (UI sends responseText)
    if (input?.responseText) {
      await ctx.db.patch(action.contactId, {
        notes: input.responseText,
      });
    }

    return {
      success: true,
      status: "completed",
      data: {
        contactId: action.contactId,
      },
    };
  },

  async onSwipeLeft(): Promise<SwipeHandlerResult> {
    // Simply discard - no side effects
    return {
      success: true,
      status: "discarded",
    };
  },
};
