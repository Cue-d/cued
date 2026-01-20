/**
 * Shared utilities for sync operations across all platforms.
 * Contains validators, types, and helper functions used by iMessage, Gmail, and Slack sync.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizePhone } from "@prm/shared";
import { normalizeEmail } from "@prm/ai";

// ============================================================================
// Shared Constants
// ============================================================================

/** Only process messages from last 7 days for action event triggers */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Current sync version - increment when schema changes require full re-sync */
export const CURRENT_SYNC_VERSION = 1;

// ============================================================================
// Shared Validators
// ============================================================================

export const handleInput = v.object({
  id: v.number(),
  identifier: v.string(),
  service: v.string(),
});

// ============================================================================
// Shared Types
// ============================================================================

export type HandleInput = Infer<typeof handleInput>;

// ============================================================================
// Event Scheduling Helpers
// ============================================================================

/**
 * Schedule action events for incoming messages on a set of conversations.
 */
export async function scheduleIncomingMessageEvents(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationIds: Set<Id<"conversations">>,
  platform: "imessage" | "gmail" | "slack" | "linkedin"
): Promise<void> {
  for (const convId of conversationIds) {
    await ctx.scheduler.runAfter(0, internal.actionEvents.onIncomingMessage, {
      userId,
      conversationId: convId,
      platform,
    });
  }
}

/**
 * Schedule action events for outgoing messages (auto-complete pending actions).
 */
export async function scheduleOutgoingMessageEvents(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationIds: Set<Id<"conversations">>
): Promise<void> {
  for (const convId of conversationIds) {
    await ctx.scheduler.runAfter(0, internal.actionEvents.onUserSentMessage, {
      userId,
      conversationId: convId,
    });
  }
}

// ============================================================================
// Handle Normalization
// ============================================================================

/**
 * Normalize a handle for consistent lookups.
 * - Phone numbers: use normalizePhone from @prm/shared
 * - Emails: use normalizeEmail from @prm/ai (handles Gmail dots, plus-addressing)
 */
export function normalizeHandle(handle: string): string {
  if (handle.includes("@")) {
    return normalizeEmail(handle);
  }
  return normalizePhone(handle);
}

// ============================================================================
// User Management
// ============================================================================

/**
 * Get existing user or create a new one from auth identity.
 * Profile data (firstName, lastName, etc.) is synced separately via users.syncProfile.
 */
export async function getOrCreateUser(
  ctx: MutationCtx,
  identity: { subject: string; email?: string }
): Promise<Doc<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
    .unique();

  if (existing) {
    return existing;
  }

  const userId = await ctx.db.insert("users", {
    workosUserId: identity.subject,
    email: identity.email ?? "",
  });

  return (await ctx.db.get(userId))!;
}

// ============================================================================
// Contact Management
// ============================================================================

/**
 * Create a placeholder contact with handle.
 */
export async function createPlaceholderContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: string
): Promise<Id<"contacts">> {
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: handle,
  });

  const normalizedHandle = normalizeHandle(handle);
  const handleType = handle.includes("@") ? "email" : "phone";
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType,
    handle: normalizedHandle,
    platform: "imessage",
  });

  return contactId;
}

// ============================================================================
// Handle Resolution
// ============================================================================

/**
 * Batch resolve handles to contact IDs.
 */
export async function batchResolveHandles(
  ctx: MutationCtx,
  userId: Id<"users">,
  handles: string[]
): Promise<Map<string, Id<"contacts">>> {
  const handleToContact = new Map<string, Id<"contacts">>();

  // Fetch in parallel batches of 50 to stay under Convex 4096 read limit
  const batchSize = 50;
  for (let i = 0; i < handles.length; i += batchSize) {
    const batch = handles.slice(i, i + batchSize);
    const promises = batch.map((handle) =>
      ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) =>
          q.eq("userId", userId).eq("handle", handle)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);

    for (let j = 0; j < batch.length; j++) {
      const result = batchResults[j];
      if (result) {
        handleToContact.set(batch[j], result.contactId);
      }
    }
  }

  return handleToContact;
}

// ============================================================================
// Integration Management
// ============================================================================

/**
 * Find integration by user and platform.
 */
export function findIntegration(
  ctx: QueryCtx,
  userId: Id<"users">,
  platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp"
): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform)
    )
    .unique();
}

/**
 * Get or create an integration record for a user+platform.
 */
export async function getOrCreateIntegration(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp"
): Promise<Doc<"integrations">> {
  const existing = await findIntegration(ctx, userId, platform);
  if (existing) return existing;

  const integrationId = await ctx.db.insert("integrations", {
    userId,
    platform,
    syncState: {
      isConnected: true,
      lastSyncCursor: "0",
    },
  });

  return (await ctx.db.get(integrationId))!;
}
