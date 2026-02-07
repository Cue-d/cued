/**
 * Shared utilities for sync operations across all platforms.
 * Contains validators, types, and helper functions used by iMessage, Gmail, and Slack sync.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  normalizePhone,
  getPhoneVariants,
  normalizeLinkedInHandle,
  normalizeMemberURN,
} from "@cued/shared";
import { normalizeEmail } from "@cued/ai";

// ============================================================================
// Shared Constants
// ============================================================================

/** Only process messages from last 7 days for action event triggers */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Current sync version - increment when schema changes require full re-sync */
export const CURRENT_SYNC_VERSION = 1;

/**
 * Maximum Gmail accounts a user can connect.
 * Prevents abuse and keeps sync manageable.
 */
export const MAX_GMAIL_ACCOUNTS = 10;

/**
 * Batch size for parallel database queries.
 * Kept under Convex's 4096 document read limit per transaction.
 */
export const BATCH_SIZE = 50;

/**
 * Maximum new_connection actions to create per social sync.
 * Prevents flooding the action queue when syncing many connections.
 */
export const MAX_NEW_CONNECTION_ACTIONS = 20;

/**
 * Platforms that support multiple workspaces (e.g., Slack teams, Gmail accounts).
 * These require workspaceId in sync cursor operations.
 */
export const MULTI_WORKSPACE_PLATFORMS = ["slack", "gmail"] as const;

// ============================================================================
// Slack Helpers
// ============================================================================

/**
 * Check if a Slack user ID belongs to a bot.
 * Bot user IDs start with "B" or are the special USLACKBOT ID.
 */
export function isSlackBot(senderId: string): boolean {
  // Bot user IDs start with "B" (e.g., B12345)
  if (senderId.startsWith("B")) {
    return true;
  }

  // Slackbot has a special user ID
  if (senderId === "USLACKBOT") {
    return true;
  }

  return false;
}

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
// Error Logging Helpers
// ============================================================================

/**
 * Log a sync error to console and return formatted error message.
 * Standardizes error logging across all sync modules.
 */
export function logSyncError(
  platform: string,
  operation: string,
  identifier: string,
  error: unknown
): string {
  const message = `[${platform} Sync] ${operation} failed for ${identifier}: ${error}`;
  console.error(message);
  return message;
}

// ============================================================================
// Event Scheduling Helpers
// ============================================================================

/**
 * Schedule action events for incoming messages on a set of conversations.
 * Uses batched scheduling - single scheduler call processes all conversations.
 */
export async function scheduleIncomingMessageEvents(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationIds: Set<Id<"conversations">>,
  platform: "imessage" | "gmail" | "slack" | "linkedin"
): Promise<void> {
  if (conversationIds.size === 0) return;

  await ctx.scheduler.runAfter(0, internal.actionEvents.onIncomingMessageBatch, {
    userId,
    conversationIds: Array.from(conversationIds),
    platform,
  });
}

/**
 * Schedule action events for outgoing messages (auto-complete pending actions).
 * Uses batched scheduling - single scheduler call processes all conversations.
 */
export async function scheduleOutgoingMessageEvents(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationIds: Set<Id<"conversations">>
): Promise<void> {
  if (conversationIds.size === 0) return;

  await ctx.scheduler.runAfter(0, internal.actionEvents.onUserSentMessageBatch, {
    userId,
    conversationIds: Array.from(conversationIds),
  });
}

// ============================================================================
// Handle Normalization
// ============================================================================

/**
 * Normalize a handle for consistent lookups.
 * - Phone numbers: use normalizePhone from @cued/shared
 * - Emails: use normalizeEmail from @cued/ai (handles Gmail dots, plus-addressing)
 */
export function normalizeHandle(handle: string): string {
  if (handle.includes("@")) {
    return normalizeEmail(handle);
  }
  return normalizePhone(handle);
}

// normalizeLinkedInHandle is imported from @cued/shared
export { normalizeLinkedInHandle };

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

/** Handle types for contact creation */
type HandleType = "phone" | "email" | "slack_id" | "linkedin_handle" | "linkedin_urn" | "twitter_handle";

/** Input for creating or finding a contact */
export interface ContactHandleInput {
  /** The raw handle value (phone, email, slack ID, LinkedIn URL, etc.) */
  value: string;
  /** The type of handle - determines normalization and storage */
  type: HandleType;
}

/** Result from getOrCreateContact */
export interface GetOrCreateContactResult {
  contactId: Id<"contacts">;
  /** True if a new contact was created (vs found existing) */
  created: boolean;
}

/**
 * Unified contact resolution: find or create a contact by handles.
 * Works across all platforms with consistent behavior:
 * 1. Normalizes handles based on type
 * 2. Looks up existing contact by any provided handle
 * 3. Updates displayName if better one provided
 * 4. Creates new contact + handles if not found
 *
 * @param ctx - Mutation context
 * @param userId - User ID
 * @param platform - Platform creating this contact
 * @param handles - One or more handles to resolve/create
 * @param displayName - Display name (uses first handle as fallback)
 * @param metadata - Optional metadata (company, notes, etc.)
 */
export async function getOrCreateContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: "imessage" | "gmail" | "slack" | "linkedin",
  handles: ContactHandleInput[],
  displayName?: string,
  metadata?: { company?: string; notes?: string }
): Promise<GetOrCreateContactResult | undefined> {
  if (handles.length === 0) {
    console.warn("[Sync] getOrCreateContact called with no handles");
    return undefined;
  }

  // Normalize all handles and filter out empty results
  const normalizedHandles = handles
    .map((h) => ({
      ...h,
      normalized: normalizeHandleByType(h.value, h.type),
    }))
    .filter((h) => {
      if (!h.normalized || h.normalized.length === 0) {
        console.warn(`[Sync] Handle normalized to empty, skipping: "${h.value}" (${h.type})`);
        return false;
      }
      return true;
    });

  // If all handles normalized to empty, we can't create a contact - return undefined to allow caller to continue
  if (normalizedHandles.length === 0) {
    console.warn(`[Sync] All handles normalized to empty for: ${handles.map(h => `"${h.value}" (${h.type})`).join(", ")}`);
    return undefined;
  }

  // Try to find existing contact by any handle (with phone variants)
  for (const handle of normalizedHandles) {
    const variants =
      handle.type === "phone"
        ? getPhoneVariants(handle.normalized)
        : [handle.normalized];

    for (const variant of variants) {
      const existing = await ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) =>
          q.eq("userId", userId).eq("handle", variant)
        )
        .unique();

      if (existing) {
        // Found existing contact - update displayName if we have a better one
        if (displayName) {
          const contact = await ctx.db.get(existing.contactId);
          if (contact && shouldUpdateDisplayName(contact.displayName, displayName, handle.normalized)) {
            await ctx.db.patch(existing.contactId, { displayName });
          }
        }
        return { contactId: existing.contactId, created: false };
      }
    }
  }

  // No existing contact found - create new one
  const finalDisplayName = displayName || normalizedHandles[0].value;
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: finalDisplayName,
    company: metadata?.company,
    notes: metadata?.notes,
  });

  // Create all handles
  for (const handle of normalizedHandles) {
    await ctx.db.insert("contactHandles", {
      userId,
      contactId,
      handleType: handle.type,
      handle: handle.normalized,
      platform,
    });
  }

  return { contactId, created: true };
}

/**
 * Normalize a handle based on its type.
 */
function normalizeHandleByType(value: string, type: HandleType): string {
  switch (type) {
    case "phone":
      return normalizePhone(value);
    case "email":
      return normalizeEmail(value);
    case "linkedin_handle":
      return normalizeLinkedInHandle(value);
    case "linkedin_urn":
      return normalizeMemberURN(value).toLowerCase();
    case "slack_id":
      // Slack IDs are already normalized (e.g., "U12345678")
      return value;
    case "twitter_handle":
      // Lowercase Twitter handles
      return value.toLowerCase().replace(/^@/, "");
    default:
      return value;
  }
}

/**
 * Check if a string looks like a placeholder/identifier rather than a real name.
 */
function isPlaceholderName(name: string): boolean {
  if (!name || !name.trim()) return true;
  // Slack user ID (e.g., "U12345678")
  if (/^U[A-Z0-9]+$/i.test(name)) return true;
  // LinkedIn URN (e.g., "urn:li:member:123")
  if (name.startsWith("urn:")) return true;
  // Phone number patterns (+15551234567, 5551234567)
  if (/^[+]?\d{10,15}$/.test(name.replace(/[\s\-()]/g, ""))) return true;
  // Email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) return true;
  return false;
}

/**
 * Count "words" in a name - useful for detecting first+last vs single name.
 */
function countNameWords(name: string): number {
  return name.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Determine if we should update the display name.
 * Only updates when newName is meaningfully better than currentName:
 * - currentName is a placeholder (Slack ID, URN, phone, email)
 * - currentName matches the handle exactly
 * - newName has more words (e.g., "John Doe" over "John") and isn't a placeholder
 */
export function shouldUpdateDisplayName(
  currentName: string,
  newName: string,
  handle: string
): boolean {
  if (!newName || newName === currentName) return false;

  // Never update TO a placeholder name
  if (isPlaceholderName(newName)) return false;

  // Never update TO a name that's just the handle
  if (newName.toLowerCase() === handle.toLowerCase()) return false;

  // Update if current name is the handle itself
  if (currentName === handle || currentName.toLowerCase() === handle.toLowerCase()) return true;

  // Update if current name is a placeholder
  if (isPlaceholderName(currentName)) return true;

  // Prefer names with more words (likely first+last) over single word
  const currentWords = countNameWords(currentName);
  const newWords = countNameWords(newName);
  if (newWords >= 2 && currentWords < 2) return true;

  return false;
}

// ============================================================================
// Handle Resolution
// ============================================================================

/**
 * Batch resolve handles to contact IDs.
 * Uses phone variants for phone handles to handle format differences
 * (e.g., "+15551234567" vs "5551234567").
 *
 * Handles phone variant collisions: multiple original handles may produce
 * the same variant (e.g., "+15551234567" and "15551234567" both produce "5551234567").
 * All originals are mapped back when a contact is found.
 */
export async function batchResolveHandles(
  ctx: MutationCtx,
  userId: Id<"users">,
  handles: string[]
): Promise<Map<string, Id<"contacts">>> {
  const handleToContact = new Map<string, Id<"contacts">>();

  // Build variant map: variant → Set of original handles
  // Multiple originals can map to the same variant (phone format differences)
  const variantToOriginals = new Map<string, Set<string>>();
  const allVariants: string[] = [];

  for (const handle of handles) {
    const isPhone = !handle.includes("@");
    const variants = isPhone ? getPhoneVariants(handle) : [handle];
    for (const variant of variants) {
      if (!variantToOriginals.has(variant)) {
        variantToOriginals.set(variant, new Set([handle]));
        allVariants.push(variant);
      } else {
        variantToOriginals.get(variant)!.add(handle);
      }
    }
  }

  // Fetch in parallel batches to stay under Convex 4096 read limit
  for (let i = 0; i < allVariants.length; i += BATCH_SIZE) {
    const batch = allVariants.slice(i, i + BATCH_SIZE);
    const promises = batch.map((variant) =>
      ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) =>
          q.eq("userId", userId).eq("handle", variant)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);

    for (let j = 0; j < batch.length; j++) {
      const result = batchResults[j];
      if (result) {
        const originalHandles = variantToOriginals.get(batch[j]);
        if (originalHandles) {
          // Map all original handles that produced this variant to the contact
          for (const originalHandle of originalHandles) {
            if (!handleToContact.has(originalHandle)) {
              handleToContact.set(originalHandle, result.contactId);
            }
          }
        }
      }
    }
  }

  return handleToContact;
}

// ============================================================================
// Sync Cursor Management
// ============================================================================

/** Platform type for sync operations */
type SyncPlatform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";

/** Options for upserting a sync cursor */
export interface UpsertSyncCursorOptions {
  /** Platform-specific cursor data (historyId, timestamp, etc.) */
  cursorData?: Record<string, unknown>;
  /** Sync mode */
  syncMode?: "full" | "incremental";
  /** Optional workspace ID for multi-workspace platforms */
  workspaceId?: string;
  /** For resumable full syncs (e.g., iMessage DESC pagination) */
  fullSyncProgress?: { phase: string; offset: number };
  /** Stats to update */
  totalMessagesSynced?: number;
  totalContactsSynced?: number;
  lastContactsSyncAt?: number;
  syncVersion?: number;
}

/**
 * Find a sync cursor by user, platform, and optional workspace.
 * Returns null if not found.
 */
export async function findSyncCursor(
  ctx: QueryCtx,
  userId: Id<"users">,
  platform: SyncPlatform,
  workspaceId?: string
): Promise<Doc<"syncCursors"> | null> {
  if (workspaceId) {
    return ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform_workspace", (q) =>
        q.eq("userId", userId).eq("platform", platform).eq("workspaceId", workspaceId)
      )
      .unique();
  }
  return ctx.db
    .query("syncCursors")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform)
    )
    .unique();
}

/**
 * Upsert a sync cursor - create if not exists, update if exists.
 * Centralizes all sync cursor logic to avoid duplication.
 * Returns the cursor ID for callers that need it.
 */
export async function upsertSyncCursor(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SyncPlatform,
  options: UpsertSyncCursorOptions = {}
): Promise<Id<"syncCursors">> {
  const now = Date.now();
  const existingCursor = await findSyncCursor(ctx, userId, platform, options.workspaceId);

  if (existingCursor) {
    // Update existing - only set fields that were provided
    await ctx.db.patch(existingCursor._id, {
      lastSyncAt: now,
      ...(options.cursorData !== undefined && { cursorData: options.cursorData }),
      ...(options.syncMode !== undefined && { syncMode: options.syncMode }),
      ...(options.fullSyncProgress !== undefined && { fullSyncProgress: options.fullSyncProgress }),
      ...(options.totalMessagesSynced !== undefined && {
        totalMessagesSynced: options.totalMessagesSynced,
      }),
      ...(options.totalContactsSynced !== undefined && {
        totalContactsSynced: options.totalContactsSynced,
      }),
      ...(options.lastContactsSyncAt !== undefined && {
        lastContactsSyncAt: options.lastContactsSyncAt,
      }),
      ...(options.syncVersion !== undefined && { syncVersion: options.syncVersion }),
    });
    return existingCursor._id;
  } else {
    // Create new cursor - only include defined fields (matches update path behavior)
    return ctx.db.insert("syncCursors", {
      userId,
      platform,
      cursorData: options.cursorData ?? {},
      lastSyncAt: now,
      syncMode: options.syncMode ?? "incremental",
      ...(options.workspaceId !== undefined && { workspaceId: options.workspaceId }),
      ...(options.fullSyncProgress !== undefined && { fullSyncProgress: options.fullSyncProgress }),
      ...(options.totalMessagesSynced !== undefined && { totalMessagesSynced: options.totalMessagesSynced }),
      ...(options.totalContactsSynced !== undefined && { totalContactsSynced: options.totalContactsSynced }),
      ...(options.lastContactsSyncAt !== undefined && { lastContactsSyncAt: options.lastContactsSyncAt }),
      ...(options.syncVersion !== undefined && { syncVersion: options.syncVersion }),
    });
  }
}

/**
 * Increment a numeric stat on a sync cursor.
 * Useful for adding to totals rather than replacing them.
 */
export async function incrementSyncCursorStat(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SyncPlatform,
  stat: "totalMessagesSynced" | "totalContactsSynced",
  increment: number,
  workspaceId?: string
): Promise<void> {
  const existingCursor = await findSyncCursor(ctx, userId, platform, workspaceId);

  if (existingCursor) {
    const currentValue = existingCursor[stat] ?? 0;
    await ctx.db.patch(existingCursor._id, {
      [stat]: currentValue + increment,
      lastSyncAt: Date.now(),
    });
  } else {
    // Create new cursor with the initial value
    await ctx.db.insert("syncCursors", {
      userId,
      platform,
      workspaceId,
      cursorData: {},
      lastSyncAt: Date.now(),
      syncMode: "incremental",
      [stat]: increment,
    });
  }
}

/**
 * Clear error on integration after successful sync.
 */
export async function clearIntegrationError(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SyncPlatform
): Promise<void> {
  const integration = await findIntegration(ctx, userId, platform);
  if (integration?.lastError) {
    await ctx.db.patch(integration._id, { lastError: undefined });
  }
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
 * Integration now only tracks connection status - sync state lives in syncCursors.
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
    isConnected: true,
  });

  return (await ctx.db.get(integrationId))!;
}
