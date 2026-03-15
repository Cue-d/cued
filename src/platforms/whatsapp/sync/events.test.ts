import { describe, expect, it } from "vitest";
import {
  buildOptimisticWhatsAppRawEvents,
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

  it("creates optimistic outbound raw events with the same message key", () => {
    const rawEvents = buildOptimisticWhatsAppRawEvents({
      accountKey: "default",
      threadName: "Soham",
      message: {
        messageID: "wamid-2",
        chatJID: "12016824050@s.whatsapp.net",
        senderJID: "15551234567@s.whatsapp.net",
        fromMe: true,
        timestamp: 1_710_000_100_000,
        text: "from cued",
        status: "sent",
      },
    });

    expect(rawEvents.map((event) => event.entityKind)).toEqual([
      "contact",
      "conversation",
      "message",
    ]);
    expect(rawEvents[2]?.payload).toEqual(
      expect.objectContaining({
        sourceMessageKey: "12016824050@s.whatsapp.net:wamid-2",
        isFromMe: true,
        status: "sent",
      }),
    );
  });
});
