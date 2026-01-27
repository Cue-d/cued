/**
 * Sync operations orchestrator.
 *
 * This file exports all public sync mutations and queries, delegating
 * implementation to platform-specific modules in ./sync/
 *
 * Platform handlers:
 * - ./sync/imessage.ts - iMessage and macOS Contacts sync
 * - ./sync/gmail.ts - Gmail emails and Google Contacts sync
 * - ./sync/slack.ts - Slack messages sync
 * - ./sync/shared.ts - Common utilities and helpers
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { platformValidator } from "./schema";
import { findUserByWorkosId } from "./lib/auth";

import { normalizeLinkedInHandle, MULTI_WORKSPACE_PLATFORMS } from "@prm/shared";
import {
  getOrCreateUser,
  findIntegration,
  getOrCreateIntegration,
  findSyncCursor,
  CURRENT_SYNC_VERSION,
  upsertSyncCursor,
  incrementSyncCursorStat,
  clearIntegrationError,
  MAX_GMAIL_ACCOUNTS,
  MAX_NEW_CONNECTION_ACTIONS,
  logSyncError,
} from "./sync/shared";
import {
  syncBatchInput,
  syncMessagesInternal,
  contactInput,
  syncContactsInternal,
  findContactByHandle,
} from "./sync/imessage";
import {
  gmailEmailInput,
  syncGmailMessagesInternal,
  googleContactInput,
  syncGoogleContactsInternal,
} from "./sync/gmail";
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
} from "./sync/linkedin";

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
 * For multi-workspace platforms (Gmail, Slack), workspaceId is required.
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
 * For multi-workspace platforms (Gmail, Slack), workspaceId is required.
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
 * For multi-workspace platforms (Gmail, Slack), workspaceId is required to reset specific workspace.
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
// Gmail Sync
// ============================================================================

/**
 * Sync Gmail emails from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 * Supports multi-account via accountEmail parameter.
 */
export const syncGmailMessages = mutation({
  args: {
    workosUserId: v.string(),
    emails: v.array(gmailEmailInput),
    /** Gmail account email for multi-account support (workspaceId) */
    accountEmail: v.optional(v.string()),
    /** Optional historyId from Gmail API for incremental sync tracking */
    historyId: v.optional(v.string()),
    /** Sync mode: 'full' on initial sync or historyId expiration, 'incremental' otherwise */
    syncMode: v.optional(v.union(v.literal("full"), v.literal("incremental"))),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    // Check multi-account limit if this is a new account
    if (args.accountEmail) {
      const existingCursors = await ctx.db
        .query("syncCursors")
        .withIndex("by_user_platform", (q) =>
          q.eq("userId", user._id).eq("platform", "gmail")
        )
        .collect();

      const isNewAccount = !existingCursors.some(
        (c) => c.workspaceId === args.accountEmail
      );

      if (isNewAccount && existingCursors.length >= MAX_GMAIL_ACCOUNTS) {
        throw new Error(
          `Maximum Gmail accounts (${MAX_GMAIL_ACCOUNTS}) reached. Disconnect an account before adding a new one.`
        );
      }

      // Update cursor state for this Gmail account
      const cursorData = {
        historyId: args.historyId,
        lastSyncAt: Date.now(),
        messageCount: args.emails.length,
      };

      await ctx.db
        .query("syncCursors")
        .withIndex("by_user_platform_workspace", (q) =>
          q
            .eq("userId", user._id)
            .eq("platform", "gmail")
            .eq("workspaceId", args.accountEmail)
        )
        .unique()
        .then(async (existing) => {
          if (existing) {
            await ctx.db.patch(existing._id, {
              cursorData,
              lastSyncAt: Date.now(),
              syncMode: args.syncMode ?? "incremental",
            });
          } else {
            await ctx.db.insert("syncCursors", {
              userId: user._id,
              platform: "gmail",
              workspaceId: args.accountEmail,
              cursorData,
              lastSyncAt: Date.now(),
              syncMode: args.syncMode ?? "full",
            });
          }
        });
    }

    return syncGmailMessagesInternal(ctx, user._id, args.emails);
  },
});

/**
 * Get Gmail cursor state for a specific account.
 * Used to check historyId and determine if full resync is needed.
 */
export const getGmailCursor = query({
  args: {
    accountEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) {
      return null;
    }

    const cursor = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform_workspace", (q) =>
        q
          .eq("userId", user._id)
          .eq("platform", "gmail")
          .eq("workspaceId", args.accountEmail)
      )
      .unique();

    if (!cursor) {
      return null;
    }

    return {
      historyId: (cursor.cursorData as { historyId?: string })?.historyId,
      lastSyncAt: cursor.lastSyncAt,
      syncMode: cursor.syncMode,
    };
  },
});

/**
 * Handle Gmail historyId expiration.
 * Called when history.list returns 404 - resets cursor for full resync.
 */
export const handleGmailHistoryExpiration = mutation({
  args: {
    workosUserId: v.string(),
    accountEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    const cursor = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform_workspace", (q) =>
        q
          .eq("userId", user._id)
          .eq("platform", "gmail")
          .eq("workspaceId", args.accountEmail)
      )
      .unique();

    if (cursor) {
      // Clear historyId and set to full sync mode
      await ctx.db.patch(cursor._id, {
        cursorData: {
          historyId: null,
          historyExpiredAt: Date.now(),
          lastSyncAt: cursor.lastSyncAt,
        },
        syncMode: "full",
      });
    }

    return { reset: true };
  },
});

/**
 * Sync Google Contacts from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 *
 * This mutation:
 * 1. Upserts contacts by email/phone handle
 * 2. Links handles to contact records
 * 3. Merges with existing iMessage contacts by phone number
 * 4. Handles deleted contacts from Google
 */
export const syncGoogleContacts = mutation({
  args: {
    workosUserId: v.string(),
    contacts: v.array(googleContactInput),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncGoogleContactsInternal(ctx, user._id, args.contacts);
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
// Social Contacts Sync (LinkedIn, Twitter)
// ============================================================================

const socialContactInput = v.object({
  name: v.string(),
  handle: v.string(),
  profileUrl: v.string(),
  headline: v.union(v.string(), v.null()),
  /** LinkedIn profile ID (URN ID portion) for matching with messaging contacts */
  profileId: v.optional(v.string()),
});

const socialPlatformValidator = v.union(
  v.literal("linkedin"),
  v.literal("twitter")
);

type SocialContactInput = Infer<typeof socialContactInput>;
type SocialPlatform = Infer<typeof socialPlatformValidator>;

/**
 * Sync social contacts from Electron scrapers to Convex.
 */
export const syncSocialContacts = mutation({
  args: {
    platform: socialPlatformValidator,
    contacts: v.array(socialContactInput),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync social contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncSocialContactsInternal(ctx, user._id, args.platform, args.contacts, args.syncedAt);
  },
});

async function syncSocialContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SocialPlatform,
  contacts: SocialContactInput[],
  syncedAt: number
) {
  const result = {
    totalContacts: contacts.length,
    newContacts: 0,
    updatedContacts: 0,
    actionsCreated: 0,
    errors: [] as string[],
    duplicatesSkipped: 0,
  };

  const handleType = platform === "linkedin" ? "username" : "twitter_handle";
  const newContactsInfo: Array<{
    contactId: Id<"contacts">;
    headline: string | null;
    profileUrl: string;
  }> = [];

  // Deduplicate contacts within batch by normalized handle
  // Skip deduplication for empty handles (invalid URLs) to avoid false positives
  const seenHandles = new Set<string>();
  const deduplicatedContacts: SocialContactInput[] = [];
  for (const contact of contacts) {
    const normalizedHandle = normalizeLinkedInHandle(contact.profileUrl);
    if (normalizedHandle && seenHandles.has(normalizedHandle)) {
      result.duplicatesSkipped++;
      continue;
    }
    if (normalizedHandle) {
      seenHandles.add(normalizedHandle);
    }
    deduplicatedContacts.push(contact);
  }

  for (const contact of deduplicatedContacts) {
    try {
      const upsertResult = await upsertSocialContact(ctx, userId, platform, handleType, contact);
      if (upsertResult.isNew) {
        result.newContacts++;
        newContactsInfo.push({
          contactId: upsertResult.contactId,
          headline: contact.headline,
          profileUrl: contact.profileUrl,
        });
      } else {
        result.updatedContacts++;
      }
    } catch (e) {
      result.errors.push(logSyncError(platform, "sync contact", contact.name, e));
    }
  }

  // Create new_connection actions for enrichment (limit 20 per sync)
  const actionsToCreate = newContactsInfo.slice(0, MAX_NEW_CONNECTION_ACTIONS);
  const now = Date.now();

  for (const info of actionsToCreate) {
    await ctx.db.insert("actions", {
      userId,
      type: "new_connection",
      status: "pending",
      priority: 40, // Medium-low priority for enrichment prompts
      contactId: info.contactId,
      platform,
      llmReason: info.headline ?? undefined,
      reason: info.profileUrl,
      createdAt: now,
    });
    result.actionsCreated++;
  }

  // Increment pending action count for user
  if (result.actionsCreated > 0) {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        pendingActionCount: (user.pendingActionCount ?? 0) + result.actionsCreated,
      });
    }
  }

  // Update sync cursor with stats
  await incrementSyncCursorStat(ctx, userId, platform, "totalContactsSynced", result.newContacts);

  // Ensure integration exists and clear any error
  await getOrCreateIntegration(ctx, userId, platform);
  await clearIntegrationError(ctx, userId, platform);

  return result;
}

function extractCompanyFromHeadline(headline: string | null): string | undefined {
  if (!headline) return undefined;
  const match = headline.match(/\s+(?:at|@)\s+(.+?)(?:\s*[|•·-]|$)/i);
  return match ? match[1].trim() : undefined;
}

async function upsertSocialContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SocialPlatform,
  handleType: "username" | "twitter_handle",
  contact: SocialContactInput
): Promise<{ isNew: boolean; contactId: Id<"contacts"> }> {
  const normalizedHandle =
    platform === "linkedin"
      ? normalizeLinkedInHandle(contact.profileUrl)
      : contact.handle.toLowerCase().replace(/^@/, "");

  // For LinkedIn, also create URN for matching with messaging contacts
  const linkedInUrn = platform === "linkedin" && contact.profileId
    ? `urn:li:member:${contact.profileId}`.toLowerCase()
    : null;

  // Try to find existing contact by username handle first
  let existingHandle = normalizedHandle
    ? await ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) => q.eq("userId", userId).eq("handle", normalizedHandle))
        .unique()
    : null;

  // If not found by username, try to find by URN (for LinkedIn - dedup with messaging contacts)
  if (!existingHandle && linkedInUrn) {
    existingHandle = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) => q.eq("userId", userId).eq("handle", linkedInUrn))
      .unique();
  }

  if (existingHandle) {
    const existingContact = await ctx.db.get(existingHandle.contactId);
    if (existingContact) {
      const company = extractCompanyFromHeadline(contact.headline);
      if (company && !existingContact.company) {
        await ctx.db.patch(existingHandle.contactId, { company });
      }
      // If we found by URN but don't have username handle, add it
      if (normalizedHandle && existingHandle.handle !== normalizedHandle) {
        const hasUsernameHandle = await ctx.db
          .query("contactHandles")
          .withIndex("by_user_handle", (q) => q.eq("userId", userId).eq("handle", normalizedHandle))
          .unique();
        if (!hasUsernameHandle) {
          await ctx.db.insert("contactHandles", {
            userId,
            contactId: existingHandle.contactId,
            handleType,
            handle: normalizedHandle,
            platform,
          });
        }
      }
    }
    return { isNew: false, contactId: existingHandle.contactId };
  }

  const company = extractCompanyFromHeadline(contact.headline);
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: contact.name,
    company,
  });

  // Insert username handle
  if (normalizedHandle) {
    await ctx.db.insert("contactHandles", {
      userId,
      contactId,
      handleType,
      handle: normalizedHandle,
      platform,
    });
  }

  // Also insert URN handle for LinkedIn (for matching with messaging)
  if (linkedInUrn) {
    await ctx.db.insert("contactHandles", {
      userId,
      contactId,
      handleType: "urn",
      handle: linkedInUrn,
      platform,
    });
  }

  return { isNew: true, contactId };
}

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
