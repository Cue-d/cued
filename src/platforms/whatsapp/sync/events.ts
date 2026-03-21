import { createHash } from "node:crypto";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
} from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import type {
  WhatsAppChatSnapshot,
  WhatsAppContactSnapshot,
  WhatsAppMessageSnapshot,
  WhatsAppSnapshot,
} from "../types.js";

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function normalizeWhatsAppJid(jid: string): string {
  return jid.trim().toLowerCase();
}

export function whatsappSourceEntityKey(jid: string): string {
  return `whatsapp:${normalizeWhatsAppJid(jid)}`;
}

export function whatsappSourceConversationKey(chatJID: string): string {
  return `whatsapp:${normalizeWhatsAppJid(chatJID)}`;
}

export function extractWhatsAppPhone(jid: string): string | null {
  const normalized = normalizeWhatsAppJid(jid);
  const [user, server] = normalized.split("@");
  if (!user || !server || !/^\d+$/.test(user)) {
    return null;
  }
  if (!server.includes("whatsapp.net")) {
    return null;
  }
  return `+${user}`;
}

export function whatsappMessageSourceKey(message: WhatsAppMessageSnapshot): string {
  return `${normalizeWhatsAppJid(message.chatJID)}:${message.messageID}`;
}

function bestContactName(contact: WhatsAppContactSnapshot): string {
  return (
    contact.name?.trim() ||
    contact.pushName?.trim() ||
    contact.phone?.trim() ||
    normalizeWhatsAppJid(contact.jid)
  );
}

export function buildWhatsAppContactEvent(
  contact: WhatsAppContactSnapshot,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const jid = normalizeWhatsAppJid(contact.jid);
  const handles = [
    {
      type: "whatsapp_jid",
      value: jid,
      deterministic: true,
    },
  ];
  const phone = contact.phone?.trim() || extractWhatsAppPhone(jid);
  if (phone) {
    handles.push({
      type: "phone",
      value: phone,
      deterministic: true,
    });
  }

  return {
    id: stableId(`whatsapp:contact:${accountKey}:${jid}:${observedAt}`),
    platform: "whatsapp",
    accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: jid,
    observedAt,
    dedupeKey: stableId(`whatsapp:contact:${accountKey}:${jid}`),
    payload: {
      sourceEntityKey: whatsappSourceEntityKey(jid),
      fields: {
        display_name: bestContactName(contact),
      },
      handles,
    } satisfies ContactObservationPayload,
    sourceVersion: "whatsapp-v1",
  };
}

export function buildWhatsAppChatEvent(
  chat: WhatsAppChatSnapshot,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const chatJID = normalizeWhatsAppJid(chat.jid);
  return {
    id: stableId(`whatsapp:conversation:${accountKey}:${chatJID}:${observedAt}`),
    platform: "whatsapp",
    accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    conversationExternalId: chatJID,
    observedAt,
    dedupeKey: stableId(`whatsapp:conversation:${accountKey}:${chatJID}`),
    payload: {
      sourceConversationKey: whatsappSourceConversationKey(chatJID),
      conversationType: chat.isGroup ? "group" : "dm",
      displayName: chat.name?.trim() || null,
      nativeConversationKey: chatJID,
      service: "whatsapp",
      participants: (chat.participants ?? [])
        .map((jid) => normalizeWhatsAppJid(jid))
        .filter((jid) => jid.length > 0)
        .map((jid) => ({ sourceEntityKey: whatsappSourceEntityKey(jid) })),
    } satisfies ConversationObservationPayload,
    sourceVersion: "whatsapp-v1",
  };
}

function buildSyntheticContactFromMessage(
  message: WhatsAppMessageSnapshot,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] | null {
  const candidate = message.fromMe
    ? message.chatJID
    : message.participantJID || message.senderJID || message.chatJID;
  if (!candidate) {
    return null;
  }

  return buildWhatsAppContactEvent(
    {
      jid: candidate,
      phone: extractWhatsAppPhone(candidate),
      name: message.pushName ?? null,
    },
    accountKey,
    observedAt,
  );
}

function buildConversationFromMessage(
  message: WhatsAppMessageSnapshot,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const isGroup = normalizeWhatsAppJid(message.chatJID).endsWith("@g.us");
  const participants = new Set<string>();
  if (message.senderJID) {
    participants.add(normalizeWhatsAppJid(message.senderJID));
  }
  if (message.participantJID) {
    participants.add(normalizeWhatsAppJid(message.participantJID));
  }
  if (!isGroup) {
    const peer = message.fromMe
      ? message.senderJID || message.participantJID || message.chatJID
      : message.chatJID;
    participants.add(normalizeWhatsAppJid(peer));
  }

  return buildWhatsAppChatEvent(
    {
      jid: message.chatJID,
      name: message.pushName ?? null,
      isGroup,
      participants: [...participants],
    },
    accountKey,
    observedAt,
  );
}

export function buildWhatsAppMessageEvent(
  message: WhatsAppMessageSnapshot,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const senderJID = !message.fromMe
    ? message.participantJID || message.senderJID || message.chatJID
    : null;
  const normalizedChatJID = normalizeWhatsAppJid(message.chatJID);
  const sourceMessageKey = whatsappMessageSourceKey(message);
  return {
    id: stableId(`whatsapp:message:${accountKey}:${sourceMessageKey}`),
    platform: "whatsapp",
    accountKey,
    entityKind: "message",
    eventKind: "created",
    externalEntityId: message.messageID,
    conversationExternalId: normalizedChatJID,
    occurredAt: message.timestamp,
    observedAt,
    dedupeKey: stableId(`whatsapp:message:${accountKey}:${sourceMessageKey}`),
    payload: {
      sourceMessageKey,
      sourceConversationKey: whatsappSourceConversationKey(normalizedChatJID),
      senderSourceKey: senderJID ? whatsappSourceEntityKey(senderJID) : null,
      sentAt: message.timestamp,
      content: message.text,
      service: "whatsapp",
      status: message.status ?? (message.fromMe ? "sent" : "delivered"),
      isFromMe: message.fromMe,
      deliveredAt: message.deliveredAt ?? null,
      readAt: message.readAt ?? null,
      attachments: message.attachments ?? [],
    } satisfies MessagePayload,
    sourceVersion: "whatsapp-v1",
  };
}

function appendMessages(
  rawEvents: SyncBundle["rawEvents"],
  messages: WhatsAppMessageSnapshot[],
  accountKey: string,
  observedBase: number,
  seenContacts: Set<string>,
  seenConversations: Set<string>,
): void {
  for (const [index, message] of messages.entries()) {
    const observedAt = observedBase + index;
    const candidateContact = normalizeWhatsAppJid(
      message.fromMe
        ? message.chatJID
        : message.participantJID || message.senderJID || message.chatJID,
    );
    if (!seenContacts.has(candidateContact)) {
      const contactEvent = buildSyntheticContactFromMessage(message, accountKey, observedAt);
      if (contactEvent) {
        rawEvents.push(contactEvent);
        seenContacts.add(candidateContact);
      }
    }

    const conversationKey = whatsappSourceConversationKey(message.chatJID);
    if (!seenConversations.has(conversationKey)) {
      rawEvents.push(buildConversationFromMessage(message, accountKey, observedAt));
      seenConversations.add(conversationKey);
    }

    rawEvents.push(buildWhatsAppMessageEvent(message, accountKey, observedAt));
  }
}

export function buildWhatsAppRawEventsFromSnapshot(options: {
  accountKey: string;
  snapshot: WhatsAppSnapshot;
  observedBase?: number;
}): SyncBundle["rawEvents"] {
  const observedBase = options.observedBase ?? Date.now();
  const rawEvents: SyncBundle["rawEvents"] = [];
  const seenContacts = new Set<string>();
  const seenConversations = new Set<string>();

  for (const [index, contact] of (options.snapshot.contacts ?? []).entries()) {
    const jid = normalizeWhatsAppJid(contact.jid);
    if (seenContacts.has(jid)) {
      continue;
    }
    seenContacts.add(jid);
    rawEvents.push(buildWhatsAppContactEvent(contact, options.accountKey, observedBase + index));
  }

  for (const [index, chat] of (options.snapshot.chats ?? []).entries()) {
    const conversationKey = whatsappSourceConversationKey(chat.jid);
    if (seenConversations.has(conversationKey)) {
      continue;
    }
    seenConversations.add(conversationKey);
    rawEvents.push(buildWhatsAppChatEvent(chat, options.accountKey, observedBase + 10_000 + index));
  }

  appendMessages(
    rawEvents,
    options.snapshot.messages ?? [],
    options.accountKey,
    observedBase + 20_000,
    seenContacts,
    seenConversations,
  );

  return rawEvents;
}
