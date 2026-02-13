/**
 * Sync operations orchestrator.
 *
 * This file exports all public sync mutations and queries, delegating
 * implementation to platform-specific modules in ./sync/
 *
 * Platform handlers:
 * - ./sync/imessage.ts - iMessage and macOS Contacts sync
 * - ./sync/slack.ts - Slack messages sync
 * - ./sync/linkedin.ts - LinkedIn messages and contacts sync
 * - ./sync/twitter.ts - Twitter/X messages and contacts sync
 * - ./sync/signal.ts - Signal messages sync
 * - ./sync/shared.ts - Common utilities and helpers
 */

import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { platformValidator } from "./schema";
import { findUserByWorkosId } from "./lib/auth";

import { MULTI_WORKSPACE_PLATFORMS } from "@cued/shared";
import {
  getOrCreateUser,
  findIntegration,
  getOrCreateIntegration,
  findSyncCursor,
  CURRENT_SYNC_VERSION,
  upsertSyncCursor,
  clearIntegrationError,
  logSyncError,
  incrementSyncCursorStat,
} from "./sync/shared";
import {
  syncBatchInput,
  syncMessagesInternal,
  contactInput,
  syncContactsInternal,
} from "./sync/imessage";
import {
  nativeSlackConversationInput,
  nativeSlackMessageInput,
  slackMentionedUserInput,
  syncSlackConversationsInternal,
  syncSlackNativeMessagesInternal,
} from "./sync/slack";
import {
  linkedInConversationsBatchInput,
  linkedInMessagesBatchInput,
  syncLinkedInConversationsInternal,
  syncLinkedInMessagesInternal,
  findContactsMissingUsernames,
  addResolvedUsernames,
  usernameResolutionInput,
  linkedInContactsBatchInput,
  syncLinkedInContactsInternal,
} from "./sync/linkedin";
import {
  twitterConversationsBatchInput,
  twitterMessagesBatchInput,
  syncTwitterConversationsInternal,
  syncTwitterMessagesInternal,
  twitterContactsBatchInput,
  syncTwitterContactsInternal,
} from "./sync/twitter";
import {
  signalMessagesBatchInput,
  syncSignalMessagesInternal,
} from "./sync/signal";

// Re-export for backwards compatibility
export { CURRENT_SYNC_VERSION };

// ============================================================================
// iMessage Sync
// ============================================================================

/**
 * Sync a batch of iMessage data from Electron to Convex.
 *
 * This mutation:
 * 1. Upserts conversations by platformConversationId
 * 2. Upserts messages by platformMessageId (dedup)
 * 3. Resolves sender handles to contact IDs
 * 4. Updates conversation lastMessage fields
 */
export const syncMessages = mutation({
  args: {
    batch: syncBatchInput,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync messages");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncMessagesInternal(ctx, user._id, args.batch);
  },
});

/**
 * Sync contacts from macOS Contacts.app to Convex.
 *
 * This mutation:
 * 1. Upserts contacts by normalized handle (finds existing by any phone/email)
 * 2. Updates displayName and company from Contacts.app data
 * 3. Links all handles to the contact record
 * 4. Handles phone number variants for US/Canada numbers
 */
export const syncContacts = mutation({
  args: {
    contacts: v.array(contactInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncContactsInternal(ctx, user._id, args.contacts);
  },
});

// ============================================================================
// Sync Cursor Management
// ============================================================================

/**
 * Get the sync cursor for a platform from the syncCursors table.
 * For multi-workspace platforms (Slack), workspaceId is required.
 */
export const getSyncCursor = query({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Require workspaceId for multi-workspace platforms
    const isMultiWorkspace = MULTI_WORKSPACE_PLATFORMS.includes(
      args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
    );
    if (isMultiWorkspace && !args.workspaceId) {
      throw new Error(`workspaceId is required for ${args.platform}`);
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const cursor = await findSyncCursor(ctx, user._id, args.platform, args.workspaceId);

    return {
      cursor: cursor?.cursorData?.lastSyncCursor ?? "0",
      lastSyncAt: cursor?.lastSyncAt ?? null,
    };
  },
});

/**
 * Get full sync state for a platform, including metadata for recovery decisions.
 * Combines data from syncCursors (sync state) and integrations (connection state).
 * For multi-workspace platforms (Slack), workspaceId is required.
 */
export const getSyncState = query({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Require workspaceId for multi-workspace platforms
    const isMultiWorkspace = MULTI_WORKSPACE_PLATFORMS.includes(
      args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
    );
    if (isMultiWorkspace && !args.workspaceId) {
      throw new Error(`workspaceId is required for ${args.platform}`);
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    if (!integration) return null;

    const cursor = await findSyncCursor(ctx, user._id, args.platform, args.workspaceId);

    return {
      cursor: cursor?.cursorData?.lastSyncCursor ?? "0",
      lastSyncAt: cursor?.lastSyncAt ?? null,
      totalMessagesSynced: cursor?.totalMessagesSynced ?? 0,
      totalContactsSynced: cursor?.totalContactsSynced ?? 0,
      syncVersion: cursor?.syncVersion ?? 0,
      isConnected: integration.isConnected,
      lastContactsSyncAt: cursor?.lastContactsSyncAt ?? null,
    };
  },
});

/**
 * Update the sync cursor for a platform after successful sync.
 */
export const updateSyncCursor = mutation({
  args: {
    platform: platformValidator,
    cursor: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    await getOrCreateIntegration(ctx, user._id, args.platform);

    await upsertSyncCursor(ctx, user._id, args.platform, {
      cursorData: { lastSyncCursor: args.cursor },
    });
    await clearIntegrationError(ctx, user._id, args.platform);

    return { success: true };
  },
});

/**
 * Update full sync metadata after successful sync.
 * Used for tracking sync progress and detecting recovery scenarios.
 */
export const updateSyncMetadata = mutation({
  args: {
    platform: platformValidator,
    cursor: v.string(),
    totalMessagesSynced: v.optional(v.number()),
    totalContactsSynced: v.optional(v.number()),
    syncVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    await getOrCreateIntegration(ctx, user._id, args.platform);

    await upsertSyncCursor(ctx, user._id, args.platform, {
      cursorData: { lastSyncCursor: args.cursor },
      totalMessagesSynced: args.totalMessagesSynced,
      totalContactsSynced: args.totalContactsSynced,
      syncVersion: args.syncVersion,
    });
    await clearIntegrationError(ctx, user._id, args.platform);

    return { success: true };
  },
});

/**
 * Reset sync state to trigger full re-sync.
 * Clears cursor and message count so recovery flow triggers full sync.
 * For multi-workspace platforms (Slack), workspaceId is required to reset specific workspace.
 * Without workspaceId for multi-workspace platforms, resets ALL workspaces.
 */
export const resetSyncState = mutation({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    const isMultiWorkspace = MULTI_WORKSPACE_PLATFORMS.includes(
      args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
    );

    // Delete existing sync cursor(s) to trigger full resync
    if (args.workspaceId) {
      const existingCursor = await findSyncCursor(ctx, user._id, args.platform, args.workspaceId);
      if (existingCursor) {
        await ctx.db.delete(existingCursor._id);
      }
    } else {
      // Delete all cursors for this platform
      const existingCursors = await ctx.db
        .query("syncCursors")
        .withIndex("by_user_platform", (q) =>
          q.eq("userId", user._id).eq("platform", args.platform)
        )
        .collect();

      for (const cursor of existingCursors) {
        await ctx.db.delete(cursor._id);
      }
    }

    // Create fresh cursor with reset state
    // Skip for multi-workspace platforms without workspaceId (they reset ALL workspaces)
    const shouldCreateFreshCursor = args.workspaceId || !isMultiWorkspace;
    if (shouldCreateFreshCursor) {
      await upsertSyncCursor(ctx, user._id, args.platform, {
        cursorData: { lastSyncCursor: "0" },
        syncMode: "full",
        totalMessagesSynced: 0,
        totalContactsSynced: 0,
        syncVersion: CURRENT_SYNC_VERSION,
        workspaceId: args.workspaceId,
      });
    }

    // Reset integration connection state
    const integration = await findIntegration(ctx, user._id, args.platform);
    if (integration) {
      await ctx.db.patch(integration._id, {
        isConnected: true,
        lastError: undefined,
      });
    }

    return { success: true };
  },
});

/**
 * Update contacts sync state after successful contacts sync.
 * Stores lastContactsSyncAt and totalContactsSynced for recovery.
 */
export const updateContactsSyncState = mutation({
  args: {
    platform: platformValidator,
    contactsCount: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    await getOrCreateIntegration(ctx, user._id, args.platform);

    await upsertSyncCursor(ctx, user._id, args.platform, {
      totalContactsSynced: args.contactsCount,
      lastContactsSyncAt: Date.now(),
    });
    await clearIntegrationError(ctx, user._id, args.platform);

    return { success: true };
  },
});

// ============================================================================
// Slack Sync
// ============================================================================

/**
 * Sync Slack conversations from native Electron integration.
 * Creates contacts from DM participants only.
 */
export const syncSlackConversations = mutation({
  args: {
    slackUserId: v.string(),
    teamId: v.string(),
    conversations: v.array(nativeSlackConversationInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Slack");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncSlackConversationsInternal(
      ctx,
      user._id,
      args.slackUserId,
      args.teamId,
      args.conversations
    );
  },
});

/**
 * Sync Slack messages from native Electron integration.
 * Properly detects isFromMe by comparing sender to slackUserId.
 * Also creates contacts for mentioned users if provided.
 */
export const syncSlackNativeMessages = mutation({
  args: {
    slackUserId: v.string(),
    teamId: v.string(),
    messages: v.array(nativeSlackMessageInput),
    mentionedUsers: v.optional(v.array(slackMentionedUserInput)),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Slack");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncSlackNativeMessagesInternal(
      ctx,
      user._id,
      args.slackUserId,
      args.teamId,
      args.messages,
      args.mentionedUsers
    );
  },
});

// ============================================================================
// LinkedIn Contacts Sync
// ============================================================================

/**
 * Sync LinkedIn contacts from Electron scraper to Convex.
 */
export const syncLinkedInContacts = mutation({
  args: linkedInContactsBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync LinkedIn contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncLinkedInContactsInternal(ctx, user._id, args.contacts);
  },
});

// ============================================================================
// Twitter Contacts Sync
// ============================================================================

/**
 * Sync Twitter contacts from Electron scraper to Convex.
 */
export const syncTwitterContacts = mutation({
  args: twitterContactsBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Twitter contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncTwitterContactsInternal(ctx, user._id, args.contacts);
  },
});

// ============================================================================
// Signal Contacts Sync
// ============================================================================

/**
 * Sync Signal contacts to Convex.
 * Reuses the shared contact upsert logic with phone-based dedup.
 * Contacts with matching phone numbers merge with existing macOS contacts.
 */
export const syncSignalContacts = mutation({
  args: {
    contacts: v.array(contactInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Signal contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncContactsInternal(ctx, user._id, args.contacts, "signal");
  },
});

// ============================================================================
// Signal Messaging Sync
// ============================================================================

/**
 * Sync Signal messages from Electron to Convex.
 * Called by SignalSyncManager after polling signal-cli.
 */
export const syncSignalMessages = mutation({
  args: signalMessagesBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Signal messages");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncSignalMessagesInternal(ctx, user._id, args.messages);
  },
});

// ============================================================================
// LinkedIn Messaging Sync
// ============================================================================

/**
 * Sync LinkedIn conversations from Electron to Convex.
 * Called by LinkedInSyncManager when fetching conversations.
 *
 * This mutation:
 * 1. Upserts conversations by entityURN (platformConversationId)
 * 2. Resolves participants to contacts via LinkedIn profile URL
 * 3. Updates conversation lastActivityAt and unreadCount
 */
export const syncLinkedInConversations = mutation({
  args: linkedInConversationsBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync LinkedIn conversations");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncLinkedInConversationsInternal(ctx, user._id, args.conversations, args.userURN);
  },
});

/**
 * Sync LinkedIn messages from Electron to Convex.
 * Called by LinkedInSyncManager when fetching messages.
 *
 * This mutation:
 * 1. Upserts messages by entityURN (platformMessageId) for deduplication
 * 2. Resolves senders to contacts via LinkedIn URN
 * 3. Updates conversation lastMessage fields
 * 4. Links contacts by LinkedIn profile URL in contactHandles table
 */
export const syncLinkedInMessages = mutation({
  args: linkedInMessagesBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync LinkedIn messages");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncLinkedInMessagesInternal(ctx, user._id, args.messages, args.userURN);
  },
});

/**
 * Find LinkedIn contacts that only have URN handles (missing public identifier/username).
 * Called after messaging sync to identify contacts needing profile lookup.
 *
 * @returns List of contacts with their member ID for profile lookup
 */
export const findLinkedInContactsMissingUsernames = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { contacts: [] };
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) {
      return { contacts: [] };
    }

    const contacts = await findContactsMissingUsernames(
      ctx as unknown as MutationCtx,
      user._id,
      args.limit ?? 50
    );
    return { contacts };
  },
});

/**
 * Add resolved usernames (public identifiers) to LinkedIn contacts.
 * Called after profile lookup to update contacts with their vanity URLs.
 *
 * @param resolutions - Array of member ID to public identifier mappings
 * @returns Number of handles added and skipped
 */
export const addLinkedInUsernames = mutation({
  args: {
    resolutions: v.array(usernameResolutionInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to add LinkedIn usernames");
    }

    const user = await getOrCreateUser(ctx, identity);
    return addResolvedUsernames(ctx, user._id, args.resolutions);
  },
});

// ============================================================================
// Twitter/X Messaging Sync
// ============================================================================

/**
 * Sync Twitter/X conversations from Electron to Convex.
 * Called by TwitterSyncManager when fetching conversation metadata.
 */
export const syncTwitterConversations = mutation({
  args: twitterConversationsBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Twitter conversations");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncTwitterConversationsInternal(ctx, user._id, args.conversations, args.twitterUserId);
  },
});

/**
 * Sync Twitter/X messages from Electron to Convex.
 * Called by TwitterSyncManager when fetching conversation events.
 */
export const syncTwitterMessages = mutation({
  args: twitterMessagesBatchInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync Twitter messages");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncTwitterMessagesInternal(ctx, user._id, args.messages, args.twitterUserId);
  },
});
