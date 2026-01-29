/**
 * New connection action handler.
 * Handles saving notes for new contacts.
 */

import type {
  ActionSwipeHandler,
  SwipeHandlerContext,
  SwipeHandlerResult,
  RightSwipeInput,
} from "./types";

export const newConnectionHandler: ActionSwipeHandler = {
  async onSwipeRight(
    { ctx, action }: SwipeHandlerContext,
    input?: RightSwipeInput
  ): Promise<SwipeHandlerResult> {
    if (!action.contactId) {
      throw new Error("new_connection action missing contactId");
    }

    // Save responseText as notes on the contact
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
        notesSaved: !!input?.responseText,
      },
    };
  },

  async onSwipeLeft({
    ctx,
    action,
  }: SwipeHandlerContext): Promise<SwipeHandlerResult> {
    // Mark contact as "not important"
    if (action.contactId) {
      await ctx.db.patch(action.contactId, {
        importance: -1,
      });
    }

    return {
      success: true,
      status: "discarded",
    };
  },
};
