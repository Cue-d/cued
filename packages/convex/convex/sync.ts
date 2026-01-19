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
import { internal } from "./_generated/api";
import { platformValidator } from "./schema";
import { findUserByWorkosId } from "./lib/auth";

// Import from platform modules
import {
  getOrCreateUser,
  findIntegration,
  getOrCreateIntegration,
  CURRENT_SYNC_VERSION,
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
  slackMessageInput,
  syncSlackMessagesInternal,
} from "./sync/slack";
import {
  linkedInConversationsBatchInput,
  linkedInMessagesBatchInput,
  syncLinkedInConversationsInternal,
  syncLinkedInMessagesInternal,
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
 * Get the sync cursor for a platform from the integrations table.
 */
export const getSyncCursor = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    return {
      cursor: integration?.syncState.lastSyncCursor ?? "0",
      lastSyncAt: integration?.syncState.lastSyncAt ?? null,
    };
  },
});

/**
 * Get full sync state for a platform, including metadata for recovery decisions.
 */
export const getSyncState = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    if (!integration) return null;

    return {
      cursor: integration.syncState.lastSyncCursor ?? "0",
      lastSyncAt: integration.syncState.lastSyncAt ?? null,
      totalMessagesSynced: integration.syncState.totalMessagesSynced ?? 0,
      totalContactsSynced: integration.syncState.totalContactsSynced ?? 0,
      syncVersion: integration.syncState.syncVersion ?? 0,
      isConnected: integration.syncState.isConnected,
      lastContactsSyncAt: integration.syncState.lastContactsSyncAt ?? null,
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
    const integration = await getOrCreateIntegration(
      ctx,
      user._id,
      args.platform
    );

    await ctx.db.patch(integration._id, {
      syncState: {
        ...integration.syncState,
        lastSyncCursor: args.cursor,
        lastSyncAt: Date.now(),
        lastError: undefined,
      },
    });

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
    const integration = await getOrCreateIntegration(
      ctx,
      user._id,
      args.platform
    );

    await ctx.db.patch(integration._id, {
      syncState: {
        ...integration.syncState,
        lastSyncCursor: args.cursor,
        lastSyncAt: Date.now(),
        lastError: undefined,
        totalMessagesSynced:
          args.totalMessagesSynced ?? integration.syncState.totalMessagesSynced,
        totalContactsSynced:
          args.totalContactsSynced ?? integration.syncState.totalContactsSynced,
        syncVersion: args.syncVersion ?? integration.syncState.syncVersion,
      },
    });

    return { success: true };
  },
});

/**
 * Reset sync state to trigger full re-sync.
 * Clears cursor and message count so recovery flow triggers full sync.
 */
export const resetSyncState = mutation({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    const integration = await findIntegration(ctx, user._id, args.platform);

    if (integration) {
      await ctx.db.patch(integration._id, {
        syncState: {
          isConnected: true,
          lastSyncCursor: "0",
          lastSyncAt: undefined,
          lastError: undefined,
          totalMessagesSynced: 0,
          totalContactsSynced: 0,
          syncVersion: CURRENT_SYNC_VERSION,
          lastContactsSyncAt: undefined,
        },
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
    const integration = await getOrCreateIntegration(
      ctx,
      user._id,
      args.platform
    );

    await ctx.db.patch(integration._id, {
      syncState: {
        ...integration.syncState,
        totalContactsSynced: args.contactsCount,
        lastContactsSyncAt: Date.now(),
        lastError: undefined,
      },
    });

    return { success: true };
  },
});

// ============================================================================
// Gmail Sync
// ============================================================================

/**
 * Sync Gmail emails from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 */
export const syncGmailMessages = mutation({
  args: {
    workosUserId: v.string(),
    emails: v.array(gmailEmailInput),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncGmailMessagesInternal(ctx, user._id, args.emails);
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
 * Sync Slack messages from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 */
export const syncSlackMessages = mutation({
  args: {
    workosUserId: v.string(),
    messages: v.array(slackMessageInput),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncSlackMessagesInternal(ctx, user._id, args.messages);
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
  };

  const handleType = platform === "linkedin" ? "linkedin_url" : "twitter_handle";
  const newContactsInfo: Array<{
    contactId: Id<"contacts">;
    headline: string | null;
    profileUrl: string;
  }> = [];

  for (const contact of contacts) {
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
      result.errors.push(`Failed to sync ${contact.name}: ${e}`);
    }
  }

  // Schedule merge candidate search for each new contact
  for (const info of newContactsInfo) {
    await ctx.scheduler.runAfter(0, internal.contactResolution.findMergeCandidatesForContact, {
      userId,
      contactId: info.contactId,
    });
  }

  // Create new_connection actions for enrichment (limit 20 per sync)
  const MAX_NEW_CONNECTION_ACTIONS = 20;
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

  // Update integration sync state
  const integration = await getOrCreateIntegration(ctx, userId, platform);
  await ctx.db.patch(integration._id, {
    syncState: {
      ...integration.syncState,
      lastSyncAt: syncedAt,
      lastError: undefined,
      totalContactsSynced: (integration.syncState.totalContactsSynced ?? 0) + result.newContacts,
    },
  });

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
  handleType: "linkedin_url" | "twitter_handle",
  contact: SocialContactInput
): Promise<{ isNew: boolean; contactId: Id<"contacts"> }> {
  const normalizedHandle =
    platform === "linkedin"
      ? contact.profileUrl.split("?")[0].toLowerCase()
      : contact.handle.toLowerCase().replace(/^@/, "");

  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) => q.eq("userId", userId).eq("handle", normalizedHandle))
    .unique();

  if (existingHandle) {
    const existingContact = await ctx.db.get(existingHandle.contactId);
    if (existingContact) {
      const company = extractCompanyFromHeadline(contact.headline);
      if (company && !existingContact.company) {
        await ctx.db.patch(existingHandle.contactId, { company });
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

  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType,
    handle: normalizedHandle,
    platform,
  });

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
    return syncLinkedInConversationsInternal(ctx, user._id, args.conversations);
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
    return syncLinkedInMessagesInternal(ctx, user._id, args.messages);
  },
});
