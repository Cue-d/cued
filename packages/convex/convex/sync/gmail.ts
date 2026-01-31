/**
 * Gmail sync operations.
 * Handles syncing emails from Gmail via Nango to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "@cued/ai";
import { normalizePhone } from "@cued/shared";
import {
  getOrCreateContact,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
  logSyncError,
  shouldUpdateDisplayName,
} from "./shared";
import { batchFetchConversations, batchFetchMessages } from "./batchUtils";
import { findContactByHandle } from "./imessage";

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
  /** Gmail label IDs for filtering (e.g., INBOX, SENT, CATEGORY_PROMOTIONS) */
  labelIds: v.optional(v.array(v.string())),
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
// Gmail Label-Based Filtering
// ============================================================================

/** Labels that indicate the email should be included */
const INCLUDE_LABELS = new Set(["INBOX", "SENT"]);

/** Labels that indicate the email should be excluded (promotional/social) */
const EXCLUDE_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

/**
 * Check if an email should be filtered out based on Gmail labels.
 * Returns true if the email should be EXCLUDED (filtered out).
 *
 * Filtering rules:
 * 1. If email has any EXCLUDE label → exclude
 * 2. If email has INBOX or SENT label → include
 * 3. Otherwise → fall through to content-based filtering
 */
export function shouldFilterByLabel(email: GmailEmailInput): boolean | "fallthrough" {
  const labels = email.labelIds ?? [];

  // Check for exclude labels first (promotions, social, updates, forums)
  if (labels.some((label) => EXCLUDE_LABELS.has(label))) {
    return true; // Should be filtered out
  }

  // Check for include labels (INBOX or SENT)
  if (labels.some((label) => INCLUDE_LABELS.has(label))) {
    return false; // Should NOT be filtered out
  }

  // No decisive label - fall through to content-based filtering
  return "fallthrough";
}

/**
 * Combined filter: first check labels, then fall back to content-based filtering.
 * Returns true if the email should be EXCLUDED.
 */
export function shouldFilterGmailEmail(email: GmailEmailInput): boolean {
  const labelResult = shouldFilterByLabel(email);

  // If labels gave a definitive answer, use it
  if (labelResult !== "fallthrough") {
    return labelResult;
  }

  // Fall back to content-based newsletter detection
  return isNewsletterOrAutomated(email);
}

// ============================================================================
// Email Parsing
// ============================================================================

/**
 * Parse email address from "Name <email@example.com>" format.
 * Also handles simple "email@example.com" format and plus addressing.
 */
export function parseEmailAddress(fromHeader: string): { name: string; email: string } {
  // Check for "Name <email>" format with angle brackets
  const bracketMatch = fromHeader.match(/^(.+?)\s*<([^\s<>]+@[^\s<>]+)>$/);
  if (bracketMatch) {
    return {
      name: bracketMatch[1].trim(),
      email: bracketMatch[2].toLowerCase(),
    };
  }

  // Simple email format without angle brackets
  const simpleMatch = fromHeader.match(/^([^\s<>]+@[^\s<>]+)$/);
  if (simpleMatch) {
    return {
      name: simpleMatch[1],
      email: simpleMatch[1].toLowerCase(),
    };
  }

  // Fallback for malformed input
  return { name: fromHeader, email: fromHeader.toLowerCase() };
}

/**
 * Parse a recipients header into individual email addresses.
 * Handles "Name <email>" and bare email formats.
 */
function parseRecipientAddresses(
  recipientsHeader?: string
): Array<{ name: string; email: string }> {
  if (!recipientsHeader) return [];

  const results: Array<{ name: string; email: string }> = [];
  const seen = new Set<string>();

  // Capture bracketed addresses first (supports names with commas).
  const bracketRegex = /([^<]*?)<\s*([^\s<>]+@[^\s<>]+)\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = bracketRegex.exec(recipientsHeader)) !== null) {
    const email = match[2].toLowerCase();
    if (seen.has(email)) continue;
    const rawName = match[1]?.trim() ?? "";
    const name = rawName.replace(/^"|"$/g, "").trim() || email;
    results.push({ name, email });
    seen.add(email);
  }

  // Remove bracketed parts before scanning for bare emails.
  const remaining = recipientsHeader.replace(/([^<]*?)<\s*([^\s<>]+@[^\s<>]+)\s*>/g, " ");
  const bareRegex = /([^\s<>,;]+@[^\s<>,;]+)/g;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bareRegex.exec(remaining)) !== null) {
    const email = bareMatch[1].toLowerCase();
    if (seen.has(email)) continue;
    results.push({ name: email, email });
    seen.add(email);
  }

  return results;
}

// ============================================================================
// Gmail Sync Implementation
// ============================================================================

/**
 * Internal sync logic for Gmail messages.
 * @param accountEmail - Gmail account email for multi-account workspaceId tracking
 */
export async function syncGmailMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  emails: GmailEmailInput[],
  accountEmail?: string
) {
  const result = {
    messagesCount: 0,
    conversationsCount: 0,
    skippedFiltered: 0,
    errors: [] as string[],
  };

  // Filter out promotional/social emails via labels, then fall back to content-based filtering
  const personalEmails = emails.filter((email) => {
    if (shouldFilterGmailEmail(email)) {
      result.skippedFiltered++;
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
  const existingConversations = await batchFetchConversations(
    ctx,
    userId,
    "gmail",
    threadIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // Batch fetch existing messages
  const messageIds = personalEmails.map((e) => e.id);
  const existingMessages = await batchFetchMessages(ctx, userId, "gmail", messageIds);
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
          ...(accountEmail && { workspaceId: accountEmail }),
        });
        conversationMap.set(threadId, conversationId);
        result.conversationsCount++;
      }

      // Insert new messages and collect participant contacts
      let latestMessage: { text: string; timestamp: number } | null = null;
      const threadParticipantIds = new Set<Id<"contacts">>();

      for (const email of threadEmails) {
        // Detect if this is a sent email (from the user)
        const isFromMe = (email.labelIds ?? []).includes("SENT");

        // Only resolve sender to contact if NOT from the user
        const senderParsed = parseEmailAddress(email.sender);
        let senderContactId: Id<"contacts"> | undefined;
        if (!isFromMe) {
          senderContactId = await getOrCreateEmailContact(
            ctx,
            userId,
            senderParsed.email,
            senderParsed.name
          );
          // Track participant for conversation (only for incoming emails)
          if (senderContactId) {
            threadParticipantIds.add(senderContactId);
          }
        } else {
          // For sent emails, resolve recipients as participants
          const recipients = parseRecipientAddresses(email.recipients);
          for (const recipient of recipients) {
            const recipientContactId = await getOrCreateEmailContact(
              ctx,
              userId,
              recipient.email,
              recipient.name
            );
            if (recipientContactId) {
              threadParticipantIds.add(recipientContactId);
            }
          }
        }

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
          isFromMe,
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
        // Merge with existing participants using explicit Set dedup
        const existingConv = await ctx.db.get(conversationId);
        const existingArr = existingConv?.participantContactIds ?? [];
        const mergedIds = new Set([...existingArr, ...threadParticipantIds]);
        // Only update if array actually changed (new participants added)
        if (mergedIds.size > existingArr.length) {
          updates.participantContactIds = Array.from(mergedIds);
        }
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(conversationId, updates);
      }
    } catch (e) {
      result.errors.push(logSyncError("Gmail", "sync thread", threadId, e));
    }
  }

  // Schedule action analysis for recent emails (event-driven)
  // Separate incoming (received) from outgoing (sent) for correct event scheduling
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();
  const outgoingConvos = new Set<Id<"conversations">>();

  for (const [threadId, threadEmails] of emailsByThread) {
    const conversationId = conversationMap.get(threadId);
    if (!conversationId) continue;

    for (const email of threadEmails) {
      const isRecent = new Date(email.date).getTime() >= cutoff;
      if (!isRecent) continue;

      const isFromMe = (email.labelIds ?? []).includes("SENT");
      if (isFromMe) {
        outgoingConvos.add(conversationId);
      } else {
        incomingConvos.add(conversationId);
      }
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "gmail");
  await scheduleOutgoingMessageEvents(ctx, userId, outgoingConvos);

  return result;
}

// ============================================================================
// Contact Management
// ============================================================================

/**
 * Get or create a contact for an email address.
 * Uses unified getOrCreateContact from shared.ts.
 */
async function getOrCreateEmailContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string,
  displayName: string
): Promise<Id<"contacts"> | undefined> {
  const result = await getOrCreateContact(
    ctx,
    userId,
    "gmail",
    [{ value: email, type: "email" }],
    displayName || email
  );
  return result?.contactId;
}

// ============================================================================
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
      result.errors.push(logSyncError("Gmail", "sync contact", contact.name, e));
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

      // Update display name if current is placeholder and we have a better one
      const primaryHandle = handles[0]?.value ?? existingContact.displayName;
      if (shouldUpdateDisplayName(existingContact.displayName, contact.name, primaryHandle)) {
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
