import { createHash, randomUUID } from "node:crypto";
import type { SyncBundle } from "./types.js";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ProviderRawEventInput,
  SourceAccountInput,
} from "../types/provider.js";

function eventId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function buildFixtureSyncBundle(): SyncBundle {
  const baseObservedAt = 1_771_000_000_000;

  const sourceAccounts: SourceAccountInput[] = [
    { platform: "contacts", accountKey: "local", displayName: "macOS Contacts" },
    { platform: "linkedin", accountKey: "default", displayName: "LinkedIn" },
    { platform: "imessage", accountKey: "local", displayName: "Messages" },
  ];

  const events: Array<
    Pick<
      ProviderRawEventInput,
      "accountKey" | "conversationExternalId" | "entityKind" | "eventKind" | "externalEntityId" | "observedAt" | "platform"
    > & {
      payload: ContactObservationPayload | ConversationObservationPayload | MessagePayload;
    }
  > = [
    {
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: baseObservedAt,
      externalEntityId: "contact_ava",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: {
          display_name: "Ava Chen",
          photo_url: "addressbook://ava-photo",
          company: "Cued",
        },
        handles: [
          { type: "email", value: "ava@cued.com", deterministic: true },
          { type: "phone", value: "+1 (415) 555-0100", deterministic: true },
        ],
      },
    },
    {
      platform: "linkedin",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: baseObservedAt + 1,
      externalEntityId: "li:ava",
      payload: {
        sourceEntityKey: "linkedin:ava",
        fields: {
          display_name: "Ava C.",
          photo_url: "https://linkedin.example/ava.jpg",
          company: "Cued Labs",
        },
        handles: [
          { type: "email", value: "ava@cued.com", deterministic: true },
          { type: "linkedin_member_urn", value: "urn:li:member:ava", deterministic: true },
        ],
      },
    },
    {
      platform: "imessage",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: baseObservedAt + 2,
      externalEntityId: "imessage:ben",
      payload: {
        sourceEntityKey: "imessage:+14155550123",
        fields: {
          display_name: "Ben Ortiz",
        },
        handles: [
          { type: "phone", value: "+1 (415) 555-0123", deterministic: true },
          { type: "imessage_handle", value: "+14155550123", deterministic: true },
        ],
      },
    },
    {
      platform: "imessage",
      accountKey: "local",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: baseObservedAt + 3,
      conversationExternalId: "chat-ava-ben",
      payload: {
        sourceConversationKey: "chat-ava-ben",
        conversationType: "dm",
        displayName: "Ava / Ben",
        participants: [
          { sourceEntityKey: "contacts:ava" },
          { sourceEntityKey: "imessage:+14155550123" },
        ],
      },
    },
    {
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: baseObservedAt + 4,
      externalEntityId: "msg-1",
      conversationExternalId: "chat-ava-ben",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "chat-ava-ben",
        senderSourceKey: "imessage:+14155550123",
        sentAt: baseObservedAt + 4,
        contentOriginal: "Can we catch up about the founder update tomorrow?",
        contentCurrent: "Can we catch up about the founder update tomorrow?",
        statusDelivery: "read",
        deliveredAt: baseObservedAt + 5,
        readAt: baseObservedAt + 6,
      },
    },
    {
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: baseObservedAt + 7,
      externalEntityId: "msg-2",
      conversationExternalId: "chat-ava-ben",
      payload: {
        sourceMessageKey: "msg-2",
        sourceConversationKey: "chat-ava-ben",
        senderSourceKey: "contacts:ava",
        sentAt: baseObservedAt + 7,
        contentOriginal: "Yes, send me the notes when you have them.",
        contentCurrent: "Yes, send me the notes when you have them.",
        statusDelivery: "delivered",
      },
    },
  ];

  const rawEvents = events.map<ProviderRawEventInput>((event) => ({
    id: randomUUID(),
    platform: event.platform,
    accountKey: event.accountKey,
    entityKind: event.entityKind,
    eventKind: event.eventKind,
    externalEntityId: event.externalEntityId ?? null,
    conversationExternalId: event.conversationExternalId ?? null,
    observedAt: event.observedAt,
    dedupeKey: eventId(
      `${event.platform}:${event.accountKey}:${event.entityKind}:${event.eventKind}:${event.externalEntityId ?? ""}:${event.conversationExternalId ?? ""}:${event.observedAt}`,
    ),
    payload: event.payload,
    sourceVersion: "fixture-v1",
  }));

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor: { fixtureOffset: rawEvents.length },
    syncMode: "full",
  };
}
