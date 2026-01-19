/**
 * Gmail sync operations.
 * Handles syncing emails from Gmail via Nango to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "@prm/ai";
import {
  scheduleIncomingMessageEvents,
  SEVEN_DAYS_MS,
} from "./shared";

// ============================================================================
// Validators
// ============================================================================

export const gmailEmailInput = v.object({
  id: v.string(), // Gmail message ID
  sender: v.string(), // From header (e.g., "John Doe <john@example.com>")
  recipients: v.optional(v.string()), // To header
  date: v.string(), // ISO date string
  subject: v.string(),
  body: v.optional(v.string()),
  attachments: v.array(
    v.object({
      filename: v.string(),
      mimeType: v.string(),
      size: v.number(),
      attachmentId: v.string(),
    })
  ),
  threadId: v.string(), // Gmail thread ID
});

// ============================================================================
// Types
// ============================================================================

export type GmailEmailInput = Infer<typeof gmailEmailInput>;

// ============================================================================
// Newsletter/Automated Email Detection
// ============================================================================

/**
 * Check if an email is likely a newsletter or automated message.
 * Used to filter out emails that shouldn't create memories.
 */
export function isNewsletterOrAutomated(email: GmailEmailInput): boolean {
  const senderLower = email.sender.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  // Common automated sender patterns
  const automatedSenderPatterns = [
    "noreply@",
    "no-reply@",
    "donotreply@",
    "do-not-reply@",
    "newsletter@",
    "notifications@",
    "updates@",
    "marketing@",
    "promo@",
    "deals@",
    "info@",
    "support@",
    "mailer-daemon@",
    "postmaster@",
  ];

  // Check sender patterns
  if (automatedSenderPatterns.some((p) => senderLower.includes(p))) {
    return true;
  }

  // Common newsletter subject patterns
  const newsletterSubjectPatterns = [
    "[newsletter]",
    "[digest]",
    "[weekly]",
    "[monthly]",
    "[daily]",
    "unsubscribe",
    "weekly roundup",
    "daily digest",
    "newsletter:",
  ];

  if (newsletterSubjectPatterns.some((p) => subjectLower.includes(p))) {
    return true;
  }

  return false;
}

// ============================================================================
// Email Parsing
// ============================================================================

/**
 * Parse email address from "Name <email@example.com>" format.
 */
export function parseEmailAddress(fromHeader: string): { name: string; email: string } {
  // Match "Name <email>" or just "email"
  const match = fromHeader.match(/^(?:(.+?)\s*)?<?([^\s<>]+@[^\s<>]+)>?$/);
  if (match) {
    return {
      name: match[1]?.trim() || match[2],
      email: match[2].toLowerCase(),
    };
  }
  return { name: fromHeader, email: fromHeader.toLowerCase() };
}

// ============================================================================
// Gmail Sync Implementation
// ============================================================================

/**
 * Internal sync logic for Gmail messages.
 */
export async function syncGmailMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  emails: GmailEmailInput[]
) {
  const result = {
    messagesCount: 0,
    conversationsCount: 0,
    skippedNewsletters: 0,
    errors: [] as string[],
  };

  // Filter out newsletters/automated emails
  const personalEmails = emails.filter((email) => {
    if (isNewsletterOrAutomated(email)) {
      result.skippedNewsletters++;
      return false;
    }
    return true;
  });

  // Group emails by threadId for efficient processing
  const emailsByThread = new Map<string, GmailEmailInput[]>();
  for (const email of personalEmails) {
    const existing = emailsByThread.get(email.threadId) ?? [];
    existing.push(email);
    emailsByThread.set(email.threadId, existing);
  }

  // Batch fetch existing conversations
  const threadIds = [...emailsByThread.keys()];
  const existingConversations = await batchFetchGmailConversations(
    ctx,
    userId,
    threadIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // Batch fetch existing messages
  const messageIds = personalEmails.map((e) => e.id);
  const existingMessages = await batchFetchGmailMessages(ctx, userId, messageIds);
  const existingMessageSet = new Set(
    existingMessages.map((m) => m.platformMessageId)
  );

  // Process each thread's emails
  for (const [threadId, threadEmails] of emailsByThread) {
    try {
      // Get or create conversation
      let conversationId = conversationMap.get(threadId);
      const firstEmail = threadEmails[0];
      const parsed = parseEmailAddress(firstEmail.sender);

      if (!conversationId) {
        conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "gmail",
          platformConversationId: threadId,
          conversationType: "dm",
          participantContactIds: [],
          unreadCount: 0,
          displayName: firstEmail.subject || parsed.name,
        });
        conversationMap.set(threadId, conversationId);
        result.conversationsCount++;
      }

      // Insert new messages and collect participant contacts
      let latestMessage: { text: string; timestamp: number } | null = null;
      const threadParticipantIds = new Set<Id<"contacts">>();

      for (const email of threadEmails) {
        // Resolve sender email to contact (always, for participant tracking)
        const senderParsed = parseEmailAddress(email.sender);
        const senderContactId = await getOrCreateEmailContact(
          ctx,
          userId,
          senderParsed.email,
          senderParsed.name
        );

        // Track participant for conversation
        threadParticipantIds.add(senderContactId);

        // Skip message insert if already exists
        if (existingMessageSet.has(email.id)) {
          continue;
        }

        const sentAtMs = new Date(email.date).getTime();

        // Combine subject and body for message content
        const content = email.body
          ? `${email.subject}\n\n${email.body}`
          : email.subject;

        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "gmail",
          content,
          sentAt: sentAtMs,
          senderContactId,
          isFromMe: false, // Nango sync gets received emails
          platformMessageId: email.id,
        });

        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || sentAtMs > latestMessage.timestamp) {
          latestMessage = { text: email.subject, timestamp: sentAtMs };
        }
      }

      // Update conversation with participants and lastMessage
      const updates: {
        lastMessageText?: string;
        lastMessageAt?: number;
        participantContactIds?: Id<"contacts">[];
      } = {};

      if (latestMessage) {
        updates.lastMessageText = latestMessage.text;
        updates.lastMessageAt = latestMessage.timestamp;
      }

      if (threadParticipantIds.size > 0) {
        // Merge with existing participants
        const existingConv = await ctx.db.get(conversationId);
        const existingIds = new Set(existingConv?.participantContactIds ?? []);
        for (const id of threadParticipantIds) {
          existingIds.add(id);
        }
        updates.participantContactIds = Array.from(existingIds);
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(conversationId, updates);
      }
    } catch (e) {
      result.errors.push(`Failed to sync thread ${threadId}: ${e}`);
    }
  }

  // Schedule action analysis for new incoming emails (event-driven)
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();

  for (const [threadId, threadEmails] of emailsByThread) {
    const conversationId = conversationMap.get(threadId);
    if (!conversationId) continue;

    const hasRecentEmail = threadEmails.some(
      (email) => new Date(email.date).getTime() >= cutoff
    );
    if (hasRecentEmail) {
      incomingConvos.add(conversationId);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "gmail");

  return result;
}

// ============================================================================
// Contact Management
// ============================================================================

/**
 * Get or create a contact for an email address.
 */
async function getOrCreateEmailContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string,
  displayName: string
): Promise<Id<"contacts">> {
  const normalizedEmailAddr = normalizeEmail(email);

  // Check if we already have a handle for this email
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", normalizedEmailAddr)
    )
    .unique();

  if (existingHandle) {
    // Update display name if we have a better one
    if (displayName && displayName !== email) {
      const existingContact = await ctx.db.get(existingHandle.contactId);
      if (existingContact && existingContact.displayName === email) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create placeholder contact
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || email,
  });

  // Create handle for email
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "email",
    handle: normalizedEmailAddr,
    platform: "gmail",
  });

  return contactId;
}

// ============================================================================
// Batch Fetch Helpers
// ============================================================================

/**
 * Batch fetch existing Gmail conversations by thread ID.
 */
async function batchFetchGmailConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  threadIds: string[]
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  const batchSize = 50;
  for (let i = 0; i < threadIds.length; i += batchSize) {
    const batch = threadIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "gmail")
            .eq("platformConversationId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((c): c is Doc<"conversations"> => c !== null)
    );
  }

  return results;
}

/**
 * Batch fetch existing Gmail messages by message ID.
 */
async function batchFetchGmailMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageIds: string[]
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  const batchSize = 50;
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q.eq("userId", userId).eq("platform", "gmail").eq("platformMessageId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((m): m is Doc<"messages"> => m !== null));
  }

  return results;
}

// ============================================================================
// Google Contacts Sync
// ============================================================================

export const googleContactInput = v.object({
  id: v.string(), // resourceName from Google People API
  name: v.string(),
  emails: v.array(v.string()),
  phones: v.array(v.string()),
  company: v.optional(v.string()),
  title: v.optional(v.string()),
  isDeleted: v.boolean(),
});

export type GoogleContactInput = Infer<typeof googleContactInput>;

/**
 * Internal sync logic for Google Contacts.
 */
export async function syncGoogleContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  contacts: GoogleContactInput[]
) {
  const result = {
    contactsCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    handlesCount: 0,
    errors: [] as string[],
  };

  for (const contact of contacts) {
    try {
      // Handle deleted contacts
      if (contact.isDeleted) {
        // Find and soft-delete the contact if it exists
        const deleted = await handleDeletedGoogleContact(ctx, userId, contact);
        if (deleted) {
          result.deletedCount++;
        }
        continue;
      }

      // Skip contacts with no identifiable handles
      if (contact.emails.length === 0 && contact.phones.length === 0) {
        continue;
      }

      const syncResult = await upsertGoogleContact(ctx, userId, contact);
      if (syncResult.isNew) {
        result.contactsCount++;
      } else {
        result.updatedCount++;
      }
      result.handlesCount += syncResult.handlesAdded;
    } catch (e) {
      result.errors.push(`Failed to sync contact ${contact.name}: ${e}`);
    }
  }

  return result;
}

/**
 * Handle a deleted Google Contact.
 * Finds the contact by any handle and removes Google-specific handles.
 */
async function handleDeletedGoogleContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: GoogleContactInput
): Promise<boolean> {
  // Import here to avoid circular dependency
  const { normalizePhone } = await import("@prm/shared");

  // Collect all handles to find the contact
  const allHandles = [
    ...contact.emails.map((e) => normalizeEmail(e)),
    ...contact.phones.map((p) => normalizePhone(p)),
  ];

  for (const handle of allHandles) {
    const existingHandle = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle)
      )
      .unique();

    if (existingHandle) {
      // Remove handles that came from Gmail (not iMessage or Slack)
      // We identify Gmail handles by checking if they're email type
      const handlesByContact = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", existingHandle.contactId))
        .collect();

      for (const h of handlesByContact) {
        // Only delete email handles from gmail platform
        if (h.platform === "gmail" && h.handleType === "email") {
          await ctx.db.delete(h._id);
        }
      }

      // Check if contact has any remaining handles
      const remainingHandles = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", existingHandle.contactId))
        .first();

      // If no handles remain, delete the contact too
      if (!remainingHandles) {
        await ctx.db.delete(existingHandle.contactId);
      }

      return true;
    }
  }

  return false;
}

/**
 * Upsert a Google Contact by finding existing contact via any of its handles,
 * or creating a new one if no match found.
 * Merges with existing iMessage/Slack contacts by phone/email.
 */
async function upsertGoogleContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: GoogleContactInput
): Promise<{ isNew: boolean; handlesAdded: number }> {
  // Import here to avoid circular dependency
  const { normalizePhone } = await import("@prm/shared");
  const { findContactByHandle } = await import("./imessage");

  // Collect all normalized handles
  const handles: Array<{ value: string; type: "phone" | "email" }> = [
    ...contact.phones.map((p) => ({
      value: normalizePhone(p),
      type: "phone" as const,
    })),
    ...contact.emails.map((e) => ({
      value: normalizeEmail(e),
      type: "email" as const,
    })),
  ];

  // Find existing contact by any handle (including iMessage phones)
  let contactId: Id<"contacts"> | null = null;
  for (const handle of handles) {
    contactId = await findContactByHandle(ctx, userId, handle);
    if (contactId) break;
  }

  const isNew = contactId === null;
  const contactData: {
    displayName: string;
    company?: string;
  } = {
    displayName: contact.name || contact.emails[0] || contact.phones[0] || "Unknown",
  };

  // Only set company if we have one
  if (contact.company) {
    contactData.company = contact.company;
  }

  if (contactId) {
    // Update existing contact with Google data (only if we have better info)
    const existingContact = await ctx.db.get(contactId);
    if (existingContact) {
      const updates: { displayName?: string; company?: string } = {};

      // Update display name if current is just a handle/placeholder
      if (
        contact.name &&
        (existingContact.displayName.includes("@") ||
          existingContact.displayName.startsWith("+") ||
          existingContact.displayName.match(/^\d+$/))
      ) {
        updates.displayName = contact.name;
      }

      // Update company if not set
      if (contact.company && !existingContact.company) {
        updates.company = contact.company;
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(contactId, updates);
      }
    }
  } else {
    // Create new contact
    contactId = await ctx.db.insert("contacts", { userId, ...contactData });
  }

  // Add missing handles (link to existing contact)
  let handlesAdded = 0;
  for (const handle of handles) {
    const existing = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle.value)
      )
      .unique();

    if (!existing) {
      // Add new handle linked to this contact
      await ctx.db.insert("contactHandles", {
        userId,
        contactId,
        handleType: handle.type,
        handle: handle.value,
        platform: "gmail", // Google Contacts sync uses gmail platform
      });
      handlesAdded++;
    } else if (existing.contactId !== contactId) {
      // Handle exists but linked to different contact - update to primary contact
      await ctx.db.patch(existing._id, { contactId });
    }
  }

  return { isNew, handlesAdded };
}
