import { createHash } from "node:crypto";
import type { SyncBundle } from "../adapters/types.js";
import type {
  ContactHandleInput,
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
} from "../types/provider.js";
import {
  bestSignalContactName,
  contactHandleType,
  makeSignalMessageFallbackId,
  type SignalContact,
  type SignalGroup,
  type SignalReceivedMessage,
} from "./signal-cli.js";

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function normalizeSignalHandle(value: string): string {
  return value.trim().toLowerCase();
}

export function signalSourceEntityKey(handle: string): string {
  return `signal:${normalizeSignalHandle(handle)}`;
}

export function signalSourceConversationKey(threadId: string): string {
  return `signal:${threadId}`;
}

function normalizeSignalAttachments(
  attachments: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return attachments.map((attachment, index) => {
    const id =
      (typeof attachment.id === "string" && attachment.id.trim().length > 0 && attachment.id) ||
      (typeof attachment.digest === "string" &&
        attachment.digest.trim().length > 0 &&
        attachment.digest) ||
      `signal-attachment:${index}`;
    const localPath =
      (typeof attachment.path === "string" && attachment.path) ||
      (typeof attachment.localPath === "string" && attachment.localPath) ||
      (typeof attachment.storedFilename === "string" && attachment.storedFilename) ||
      (typeof attachment.file === "string" && attachment.file) ||
      null;
    const contentType =
      (typeof attachment.contentType === "string" && attachment.contentType) ||
      (typeof attachment.mimeType === "string" && attachment.mimeType) ||
      (typeof attachment.mimetype === "string" && attachment.mimetype) ||
      null;
    const size =
      typeof attachment.size === "number"
        ? attachment.size
        : typeof attachment.sizeBytes === "number"
          ? attachment.sizeBytes
          : typeof attachment.length === "number"
            ? attachment.length
            : null;

    return {
      id,
      kind: "file",
      filename:
        (typeof attachment.filename === "string" && attachment.filename) ||
        (typeof attachment.fileName === "string" && attachment.fileName) ||
        null,
      mime_type: contentType,
      size_bytes: size,
      local_path: localPath,
      access_kind: localPath ? "local_path" : "none",
      availability_status: localPath ? "available" : "unsupported_pending_signal_fetch",
      access_ref: localPath ? { path: localPath } : null,
      provider_metadata: { ...attachment },
    };
  });
}

function contactHandles(contact: SignalContact): ContactHandleInput[] {
  const handles: ContactHandleInput[] = [];
  if (typeof contact.number === "string" && contact.number.trim().length > 0) {
    handles.push({
      type: "phone",
      value: contact.number.trim(),
      deterministic: true,
    });
  }
  if (typeof contact.uuid === "string" && contact.uuid.trim().length > 0) {
    handles.push({
      type: "signal_id",
      value: contact.uuid.trim().toLowerCase(),
      deterministic: true,
    });
  }
  return handles;
}

export function buildSignalContactEvent(
  contact: SignalContact,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] | null {
  const handle = contact.number?.trim() || contact.uuid?.trim()?.toLowerCase();
  if (!handle) {
    return null;
  }

  return {
    id: stableId(`signal:contact:${accountKey}:${handle}:${observedAt}`),
    platform: "signal",
    accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: handle,
    observedAt,
    dedupeKey: stableId(`signal:contact:${accountKey}:${handle}`),
    payload: {
      sourceEntityKey: signalSourceEntityKey(handle),
      fields: {
        display_name: bestSignalContactName(contact),
      },
      handles: contactHandles(contact),
    } satisfies ContactObservationPayload,
    sourceVersion: "signal-v1",
  };
}

export function buildSignalGroupConversationEvent(
  group: SignalGroup,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] | null {
  const groupId = group.groupId?.trim() || group.id?.trim();
  if (!groupId) {
    return null;
  }

  return {
    id: stableId(`signal:conversation:${accountKey}:${groupId}:${observedAt}`),
    platform: "signal",
    accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    conversationExternalId: groupId,
    observedAt,
    dedupeKey: stableId(`signal:conversation:${accountKey}:${groupId}`),
    payload: {
      sourceConversationKey: signalSourceConversationKey(`group:${groupId}`),
      conversationType: "group",
      displayName: group.name?.trim() || group.title?.trim() || "Signal Group",
      nativeConversationKey: groupId,
      service: "signal",
      participants: (group.members ?? [])
        .map((member) => member.number?.trim() || member.uuid?.trim()?.toLowerCase() || "")
        .filter((member): member is string => member.length > 0)
        .map((member) => ({ sourceEntityKey: signalSourceEntityKey(member) })),
    } satisfies ConversationObservationPayload,
    sourceVersion: "signal-v1",
  };
}

export function buildSignalMessageConversationEvent(
  message: SignalReceivedMessage,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const participants =
    message.threadType === "group"
      ? []
      : message.peerHandle
        ? [{ sourceEntityKey: signalSourceEntityKey(message.peerHandle) }]
        : [];

  return {
    id: stableId(`signal:conversation:${accountKey}:${message.threadId}:${observedAt}`),
    platform: "signal",
    accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    conversationExternalId: message.threadId,
    observedAt,
    dedupeKey: stableId(`signal:conversation:${accountKey}:${message.threadId}`),
    payload: {
      sourceConversationKey: signalSourceConversationKey(message.threadId),
      conversationType: message.threadType,
      displayName: message.threadName ?? message.peerHandle ?? null,
      nativeConversationKey: message.threadId,
      service: "signal",
      participants,
    } satisfies ConversationObservationPayload,
    sourceVersion: "signal-v1",
  };
}

export function buildSyntheticSignalContactEvent(
  handle: string,
  displayName: string,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  return {
    id: stableId(`signal:contact:${accountKey}:${handle}:${observedAt}`),
    platform: "signal",
    accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: handle,
    observedAt,
    dedupeKey: stableId(`signal:contact:${accountKey}:${handle}`),
    payload: {
      sourceEntityKey: signalSourceEntityKey(handle),
      fields: {
        display_name: displayName,
      },
      handles: [
        {
          type: contactHandleType(handle),
          value: handle,
          deterministic: true,
        },
      ],
    } satisfies ContactObservationPayload,
    sourceVersion: "signal-v1",
  };
}

export function buildSignalMessageEvent(
  message: SignalReceivedMessage,
  accountKey: string,
  observedAt: number,
): SyncBundle["rawEvents"][number] {
  const senderHandle = !message.isFromMe
    ? message.senderHandle || message.peerHandle || null
    : null;
  return {
    id: stableId(`signal:message:${accountKey}:${message.messageId}`),
    platform: "signal",
    accountKey,
    entityKind: "message",
    eventKind: "message_created",
    externalEntityId: message.messageId,
    conversationExternalId: message.threadId,
    occurredAt: message.sentAt,
    observedAt,
    dedupeKey: stableId(`signal:message:${accountKey}:${message.messageId}`),
    payload: {
      sourceMessageKey: message.messageId,
      sourceConversationKey: signalSourceConversationKey(message.threadId),
      senderSourceKey: senderHandle ? signalSourceEntityKey(senderHandle) : null,
      sentAt: message.sentAt,
      content: message.text,
      service: "signal",
      status: message.isFromMe ? "sent" : "delivered",
      isFromMe: message.isFromMe,
      deliveredAt: message.sentAt,
      attachments: normalizeSignalAttachments(message.attachments),
    } satisfies MessagePayload,
    sourceVersion: "signal-v1",
  };
}

export function buildOptimisticSignalRawEvents(options: {
  accountKey: string;
  recipientHandle: string;
  threadId: string;
  threadName?: string | null;
  text: string;
  sentAt: number;
  observedAt?: number;
}): SyncBundle["rawEvents"] {
  const observedAt = options.observedAt ?? options.sentAt;
  const threadType = options.threadId.startsWith("group:") ? "group" : "dm";
  const message: SignalReceivedMessage = {
    messageId: makeSignalMessageFallbackId({
      timestamp: options.sentAt,
      threadId: options.threadId,
      isFromMe: true,
      text: options.text,
      fallbackIndex: 0,
    }),
    threadId: options.threadId,
    threadType,
    threadName: options.threadName ?? undefined,
    text: options.text,
    sentAt: options.sentAt,
    isFromMe: true,
    senderHandle: undefined,
    senderName: undefined,
    peerHandle: threadType === "dm" ? options.recipientHandle : undefined,
    attachments: [],
  };

  return buildSignalRawEventsFromMessages({
    accountKey: options.accountKey,
    messages: [message],
    observedBase: observedAt,
  });
}

function appendMessageEvents(
  rawEvents: SyncBundle["rawEvents"],
  messages: SignalReceivedMessage[],
  accountKey: string,
  observedBase: number,
  seenContacts: Set<string>,
  seenConversations: Set<string>,
): void {
  for (const [index, message] of messages.entries()) {
    const observedAt = observedBase + index;
    const peerHandle = message.peerHandle || message.senderHandle;
    if (peerHandle && !seenContacts.has(peerHandle)) {
      seenContacts.add(peerHandle);
      rawEvents.push(
        buildSyntheticSignalContactEvent(
          peerHandle,
          message.senderName ?? peerHandle,
          accountKey,
          observedAt,
        ),
      );
    }

    const conversationKey = signalSourceConversationKey(message.threadId);
    if (!seenConversations.has(conversationKey)) {
      seenConversations.add(conversationKey);
      rawEvents.push(buildSignalMessageConversationEvent(message, accountKey, observedAt));
    }

    rawEvents.push(buildSignalMessageEvent(message, accountKey, observedAt));
  }
}

export function buildSignalRawEventsFromSnapshot(options: {
  accountKey: string;
  contacts: SignalContact[];
  groups: SignalGroup[];
  messages: SignalReceivedMessage[];
  observedBase?: number;
}): SyncBundle["rawEvents"] {
  const observedBase = options.observedBase ?? Date.now();
  const rawEvents: SyncBundle["rawEvents"] = [];
  const seenContacts = new Set<string>();
  const seenConversations = new Set<string>();

  for (const [index, contact] of options.contacts.entries()) {
    const handle = contact.number?.trim() || contact.uuid?.trim()?.toLowerCase();
    if (!handle || seenContacts.has(handle)) {
      continue;
    }
    seenContacts.add(handle);
    const event = buildSignalContactEvent(contact, options.accountKey, observedBase + index);
    if (event) {
      rawEvents.push(event);
    }
  }

  for (const [index, group] of options.groups.entries()) {
    const event = buildSignalGroupConversationEvent(
      group,
      options.accountKey,
      observedBase + 1_000 + index,
    );
    if (!event) {
      continue;
    }
    const payload = event.payload as ConversationObservationPayload;
    if (seenConversations.has(payload.sourceConversationKey)) {
      continue;
    }
    seenConversations.add(payload.sourceConversationKey);
    rawEvents.push(event);
  }

  appendMessageEvents(
    rawEvents,
    options.messages,
    options.accountKey,
    observedBase + 10_000,
    seenContacts,
    seenConversations,
  );

  return rawEvents;
}

export function buildSignalRawEventsFromMessages(options: {
  accountKey: string;
  messages: SignalReceivedMessage[];
  observedBase?: number;
}): SyncBundle["rawEvents"] {
  const rawEvents: SyncBundle["rawEvents"] = [];
  appendMessageEvents(
    rawEvents,
    options.messages,
    options.accountKey,
    options.observedBase ?? Date.now(),
    new Set<string>(),
    new Set<string>(),
  );
  return rawEvents;
}
