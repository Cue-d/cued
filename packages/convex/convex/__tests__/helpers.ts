/**
 * Test helpers for Convex function tests.
 *
 * These utilities help create test data and mock authenticated users
 * for testing Convex queries and mutations.
 */

import type { Id } from "../_generated/dataModel";

/**
 * Create a test user identity for authenticated requests.
 * Use with `t.withIdentity()` to simulate authenticated users.
 */
export function createTestIdentity(overrides: Partial<{
  name: string;
  email: string;
  subject: string;
}> = {}) {
  return {
    name: overrides.name ?? "Test User",
    email: overrides.email ?? "test@example.com",
    subject: overrides.subject ?? `workos|user_${Date.now()}`,
    issuer: "https://api.workos.com",
    tokenIdentifier: `workos|user_${Date.now()}`,
  };
}

/**
 * Generate test data for creating a user.
 */
export function createTestUserData(overrides: Partial<{
  workosUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  plan: string;
  pendingActionCount: number;
}> = {}) {
  return {
    workosUserId: overrides.workosUserId ?? `user_${Date.now()}`,
    email: overrides.email ?? "test@example.com",
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "User",
    plan: overrides.plan ?? "free",
    pendingActionCount: overrides.pendingActionCount ?? 0,
  };
}

/**
 * Generate test data for creating a contact.
 */
export function createTestContactData(
  userId: Id<"users">,
  overrides: Partial<{
    displayName: string;
    company: string;
    notes: string;
    importance: number;
    tags: string[];
  }> = {}
) {
  return {
    userId,
    displayName: overrides.displayName ?? "Test Contact",
    company: overrides.company,
    notes: overrides.notes,
    importance: overrides.importance,
    tags: overrides.tags,
  };
}

/**
 * Generate test data for creating a conversation.
 */
export function createTestConversationData(
  userId: Id<"users">,
  overrides: Partial<{
    platform: "imessage" | "gmail" | "slack";
    platformConversationId: string;
    conversationType: "dm" | "group" | "channel";
    participantContactIds: Id<"contacts">[];
    lastMessageText: string;
    lastMessageAt: number;
    unreadCount: number;
    displayName: string;
  }> = {}
) {
  return {
    userId,
    platform: overrides.platform ?? "imessage",
    platformConversationId: overrides.platformConversationId ?? `conv_${Date.now()}`,
    conversationType: overrides.conversationType ?? "dm",
    participantContactIds: overrides.participantContactIds ?? [],
    lastMessageText: overrides.lastMessageText,
    lastMessageAt: overrides.lastMessageAt ?? Date.now(),
    unreadCount: overrides.unreadCount ?? 0,
    displayName: overrides.displayName,
  };
}

/**
 * Generate test data for creating a message.
 */
export function createTestMessageData(
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  overrides: Partial<{
    platform: "imessage" | "gmail" | "slack";
    content: string;
    sentAt: number;
    senderContactId: Id<"contacts">;
    isFromMe: boolean;
    platformMessageId: string;
  }> = {}
) {
  return {
    userId,
    conversationId,
    platform: overrides.platform ?? "imessage",
    content: overrides.content ?? "Test message",
    sentAt: overrides.sentAt ?? Date.now(),
    senderContactId: overrides.senderContactId,
    isFromMe: overrides.isFromMe ?? false,
    platformMessageId: overrides.platformMessageId ?? `msg_${Date.now()}`,
  };
}

/**
 * Generate test data for creating an action.
 */
export function createTestActionData(
  userId: Id<"users">,
  overrides: Partial<{
    type: "respond" | "follow_up" | "send_message" | "eod_contact" | "resolve_contact" | "new_connection";
    status: "pending" | "completed" | "discarded" | "snoozed" | "expired";
    priority: number;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    messageId: Id<"messages">;
    platform: "imessage" | "gmail" | "slack";
    draftResponse: string;
    reason: string;
    createdAt: number;
    snoozedUntil: number;
  }> = {}
) {
  return {
    userId,
    type: overrides.type ?? "respond",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 50,
    conversationId: overrides.conversationId,
    contactId: overrides.contactId,
    messageId: overrides.messageId,
    platform: overrides.platform,
    draftResponse: overrides.draftResponse,
    reason: overrides.reason,
    createdAt: overrides.createdAt ?? Date.now(),
    snoozedUntil: overrides.snoozedUntil,
  };
}

/**
 * Generate test data for creating a contact handle.
 */
export function createTestContactHandleData(
  userId: Id<"users">,
  contactId: Id<"contacts">,
  overrides: Partial<{
    handleType: "phone" | "email" | "slack_id";
    handle: string;
    platform: "imessage" | "gmail" | "slack";
  }> = {}
) {
  return {
    userId,
    contactId,
    handleType: overrides.handleType ?? "phone",
    handle: overrides.handle ?? "+15551234567",
    platform: overrides.platform ?? "imessage",
  };
}

/**
 * Generate test data for creating an integration.
 */
export function createTestIntegrationData(
  userId: Id<"users">,
  overrides: Partial<{
    platform: "imessage" | "gmail" | "slack";
    nangoConnectionId: string;
    connectedAt: number;
  }> = {}
) {
  return {
    userId,
    platform: overrides.platform ?? "imessage",
    nangoConnectionId: overrides.nangoConnectionId,
    connectedAt: overrides.connectedAt ?? Date.now(),
    syncState: {
      isConnected: true,
      lastSyncAt: Date.now(),
    },
  };
}
