"use node";
/**
 * Types for action swipe handlers.
 * Each action type implements these interfaces for backend processing.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Context passed to all swipe handlers.
 */
export interface SwipeHandlerContext {
  /** Convex mutation context */
  ctx: MutationCtx;
  /** Authenticated user */
  user: Doc<"users">;
  /** The action being swiped */
  action: Doc<"actions">;
  /** Current timestamp */
  now: number;
}

/**
 * Result returned by swipe handlers.
 */
export interface SwipeHandlerResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** New status for the action */
  status: "completed" | "discarded" | "snoozed";
  /** Additional data returned to the client */
  data?: Record<string, unknown>;
}

/**
 * Input for right swipe (confirm/send).
 */
export interface RightSwipeInput {
  /** Response text for message actions */
  responseText?: string;
  /** Notes for contact actions */
  notes?: string;
}

/**
 * Input for up swipe (snooze).
 */
export interface UpSwipeInput {
  /** When the action should reappear */
  snoozedUntil: number;
}

/**
 * Handler interface for each action type.
 * Implementations define behavior for each swipe direction.
 */
export interface ActionSwipeHandler {
  /**
   * Handle right swipe (confirm/send).
   * @param ctx - Handler context
   * @param input - Optional input data
   * @returns Result with new status
   */
  onSwipeRight(
    ctx: SwipeHandlerContext,
    input?: RightSwipeInput
  ): Promise<SwipeHandlerResult>;

  /**
   * Handle left swipe (discard/reject).
   * @param ctx - Handler context
   * @returns Result with new status
   */
  onSwipeLeft(ctx: SwipeHandlerContext): Promise<SwipeHandlerResult>;

  /**
   * Handle up swipe (snooze).
   * Default implementation provided if not overridden.
   * @param ctx - Handler context
   * @param input - Snooze input with snoozedUntil timestamp
   * @returns Result with new status
   */
  onSwipeUp?(
    ctx: SwipeHandlerContext,
    input: UpSwipeInput
  ): Promise<SwipeHandlerResult>;
}

/**
 * Default snooze handler - used when action type doesn't override.
 */
export async function defaultSnoozeHandler(
  _ctx: SwipeHandlerContext,
  input: UpSwipeInput
): Promise<SwipeHandlerResult> {
  return {
    success: true,
    status: "snoozed",
    data: { snoozedUntil: input.snoozedUntil },
  };
}
