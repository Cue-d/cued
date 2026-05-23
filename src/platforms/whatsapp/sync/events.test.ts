import { describe, expect, it } from "vitest";
import {
  buildWhatsAppCallDeleteEvent,
  buildWhatsAppMessageEvent,
  buildWhatsAppRawEventsFromSnapshot,
  extractWhatsAppPhone,
  normalizeWhatsAppJid,
  whatsappMessageSourceKey,
} from "./events.js";

describe("whatsapp events", () => {
  it("normalizes WhatsApp jids and extracts phone handles", () => {
    expect(normalizeWhatsAppJid(" 12016824050@S.WHATSAPP.NET ")).toBe("12016824050@s.whatsapp.net");
    expect(extractWhatsAppPhone("12016824050@s.whatsapp.net")).toBe("+12016824050");
    expect(extractWhatsAppPhone("group@g.us")).toBeNull();
  });

  it("builds deterministic raw events from snapshots", () => {
    const rawEvents = buildWhatsAppRawEventsFromSnapshot({
      accountKey: "default",
      snapshot: {
        contacts: [
          {
            jid: "12016824050@s.whatsapp.net",
            name: "Soham",
          },
        ],
        chats: [
          {
            jid: "12016824050@s.whatsapp.net",
            isGroup: false,
            participants: ["12016824050@s.whatsapp.net"],
          },
        ],
        messages: [
          {
            messageID: "wamid-1",
            chatJID: "12016824050@s.whatsapp.net",
            senderJID: "12016824050@s.whatsapp.net",
            fromMe: false,
            timestamp: 1_710_000_000_000,
            text: "hello",
            status: "delivered",
          },
        ],
      },
      observedBase: 1_710_000_000_500,
    });

    expect(rawEvents.map((event) => event.entityKind)).toEqual([
      "contact",
      "conversation",
      "message",
    ]);
    expect(rawEvents[2]?.payload).toEqual(
      expect.objectContaining({
        sourceMessageKey: "12016824050@s.whatsapp.net:wamid-1",
        senderSourceKey: "whatsapp:12016824050@s.whatsapp.net",
        content: "hello",
        service: "whatsapp",
      }),
    );
    expect(
      whatsappMessageSourceKey({
        messageID: "wamid-1",
        chatJID: "12016824050@s.whatsapp.net",
        fromMe: false,
        timestamp: 1,
        text: "x",
      }),
    ).toBe("12016824050@s.whatsapp.net:wamid-1");
  });

  it("adds MIME-aware fallback filenames for WhatsApp documents without names", () => {
    const event = buildWhatsAppMessageEvent(
      {
        messageID: "wamid-doc",
        chatJID: "12016824050@s.whatsapp.net",
        fromMe: false,
        timestamp: 1_710_000_000_000,
        text: "",
        attachments: [
          {
            id: "doc-1",
            kind: "document",
            mime_type: "application/pdf",
          },
          {
            id: "csv-1",
            kind: "document",
            mimetype: "text/csv",
          },
        ],
      },
      "default",
      1_710_000_000_500,
    );

    expect(event.payload).toEqual(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ filename: "file.pdf" }),
          expect.objectContaining({ filename: "file.csv" }),
        ],
      }),
    );
  });

  it("builds canonical call events from WhatsApp call snapshots", () => {
    const rawEvents = buildWhatsAppRawEventsFromSnapshot({
      accountKey: "default",
      snapshot: {
        calls: [
          {
            callID: "call-1",
            chatJID: "12016824050@s.whatsapp.net",
            initiatorJID: "15551234567@s.whatsapp.net",
            remoteJID: "12016824050@s.whatsapp.net",
            fromMe: false,
            timestamp: 1_710_000_001_000,
            durationSeconds: 61,
            status: "completed",
            medium: "audio",
            providerCallType: "regular",
          },
        ],
      },
      observedBase: 1_710_000_000_500,
    });

    expect(rawEvents.map((event) => event.entityKind)).toEqual([
      "contact",
      "contact",
      "conversation",
      "call",
    ]);
    expect(rawEvents[3]).toMatchObject({
      platform: "whatsapp",
      entityKind: "call",
      eventKind: "observed",
      sourceVersion: "whatsapp-v1",
      payload: {
        sourceCallKey: "12016824050@s.whatsapp.net:call-1",
        sourceConversationKey: "whatsapp:12016824050@s.whatsapp.net",
        provider: "whatsapp",
        providerCallType: "regular",
        direction: "incoming",
        medium: "audio",
        status: "completed",
        durationSeconds: 61,
        endedAt: 1_710_000_062_000,
      },
    });
  });

  it("builds canonical call delete events from WhatsApp app-state deletes", () => {
    const event = buildWhatsAppCallDeleteEvent(
      {
        chatJID: "12016824050@s.whatsapp.net",
        fromMe: true,
      },
      "default",
      1_710_000_000_500,
    );

    expect(event).toMatchObject({
      platform: "whatsapp",
      entityKind: "call",
      eventKind: "deleted",
      conversationExternalId: "12016824050@s.whatsapp.net",
      payload: {
        sourceConversationKey: "whatsapp:12016824050@s.whatsapp.net",
        provider: "whatsapp",
        direction: "outgoing",
      },
    });
  });

  it("maps WhatsApp reply, forward, and revoke metadata onto message payloads", () => {
    const rawEvents = buildWhatsAppRawEventsFromSnapshot({
      accountKey: "default",
      snapshot: {
        messages: [
          {
            messageID: "wamid-reply",
            chatJID: "12016824050@s.whatsapp.net",
            senderJID: "12016824050@s.whatsapp.net",
            fromMe: false,
            timestamp: 1_710_000_002_000,
            text: "reply",
            replyToMessageID: "wamid-parent",
            replyToSenderJID: "15551234567@s.whatsapp.net",
            isForwarded: true,
            forwardingScore: 2,
            status: "delivered",
          },
          {
            messageID: "wamid-revoked",
            chatJID: "12016824050@s.whatsapp.net",
            fromMe: true,
            timestamp: 1_710_000_003_000,
            text: "",
            revoked: true,
            status: "sent",
          },
        ],
      },
      observedBase: 1_710_000_000_500,
    });

    const messageEvents = rawEvents.filter((event) => event.entityKind === "message");
    expect(messageEvents[0]?.payload).toMatchObject({
      sourceMessageKey: "12016824050@s.whatsapp.net:wamid-reply",
      replyToSourceMessageKey: "12016824050@s.whatsapp.net:wamid-parent",
      isDeleted: false,
      providerMetadata: {
        whatsapp: {
          isForwarded: true,
          forwardingScore: 2,
          replyToSenderJID: "15551234567@s.whatsapp.net",
        },
      },
    });
    expect(messageEvents[1]?.payload).toMatchObject({
      sourceMessageKey: "12016824050@s.whatsapp.net:wamid-revoked",
      isDeleted: true,
      deletedAt: 1_710_000_003_000,
    });
    expect(messageEvents[1]?.eventKind).toBe("deleted");
  });
});
