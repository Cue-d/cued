/**
 * Handler Registry - Maps action types to their swipe handlers.
 */

import type {
  ActionSwipeHandler,
  SwipeHandlerContext,
  SwipeHandlerResult,
  RightSwipeInput,
  UpSwipeInput,
} from "./types";
import { defaultSnoozeHandler } from "./types";
import { respondHandler, followUpHandler, sendMessageHandler } from "./message";
import { resolveContactHandler } from "./resolve-contact";
import { newConnectionHandler } from "./new-connection";
import { eodContactHandler } from "./eod-contact";

/**
 * Registry mapping action types to their handlers.
 */
const HANDLER_REGISTRY: Record<string, ActionSwipeHandler> = {
  respond: respondHandler,
  follow_up: followUpHandler,
  send_message: sendMessageHandler,
  resolve_contact: resolveContactHandler,
  new_connection: newConnectionHandler,
  eod_contact: eodContactHandler,
};

/**
 * Execute the appropriate swipe handler for an action.
 *
 * @param actionType - The type of action being swiped
 * @param direction - The swipe direction
 * @param handlerCtx - Context for the handler
 * @param input - Optional input data
 * @returns The handler result
 * @throws Error if action type is not registered
 */
export async function executeSwipeHandler(
  actionType: string,
  direction: "left" | "right" | "up",
  handlerCtx: SwipeHandlerContext,
  input?: { responseText?: string; snoozedUntil?: number }
): Promise<SwipeHandlerResult> {
  const handler = HANDLER_REGISTRY[actionType];

  if (!handler) {
    throw new Error(`No handler registered for action type: ${actionType}`);
  }

  switch (direction) {
    case "right":
      return handler.onSwipeRight(handlerCtx, input as RightSwipeInput);

    case "left":
      return handler.onSwipeLeft(handlerCtx);

    case "up": {
      if (!input?.snoozedUntil) {
        throw new Error("snoozedUntil is required for snooze action");
      }
      const upInput: UpSwipeInput = { snoozedUntil: input.snoozedUntil };
      // Use handler's snooze if defined, otherwise use default
      if (handler.onSwipeUp) {
        return handler.onSwipeUp(handlerCtx, upInput);
      }
      return defaultSnoozeHandler(handlerCtx, upInput);
    }

    default:
      throw new Error(`Unknown swipe direction: ${direction}`);
  }
}

/**
 * Get the handler for an action type.
 */
export function getActionHandler(
  actionType: string
): ActionSwipeHandler | undefined {
  return HANDLER_REGISTRY[actionType];
}

/**
 * Check if an action type has a registered handler.
 */
export function hasHandler(actionType: string): boolean {
  return actionType in HANDLER_REGISTRY;
}
