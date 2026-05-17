import { describe, expect, it } from "vitest";
import {
  buildSignalMessageEvent,
  buildSignalRawEventsFromMessages,
  buildSignalRawEventsFromSnapshot,
} from "./events.js";

describe("signal events", () => {
  it("reuses message identifiers between realtime and catch-up normalization", () => {
    const message = {
      messageId: "msg-1",
      threadId: "dm:+14155550123",
      threadType: "dm" as const,
      text: "Hello from Signal",
      sentAt: 1_710_000_000_000,
      isFromMe: false,
      senderHandle: "+14155550123",
      senderName: "Ben Ortiz",
      peerHandle: "+14155550123",
      attachments: [],
    };

    const realtimeEvents = buildSignalRawEventsFromMessages({
      accountKey: "default",
      messages: [message],
      observedBase: 100,
    });
    const snapshotEvents = buildSignalRawEventsFromSnapshot({
      accountKey: "default",
      contacts: [],
      groups: [],
      messages: [message],
      observedBase: 100,
    });

    const realtimeMessage = realtimeEvents.find((event) => event.entityKind === "message");
    const snapshotMessage = snapshotEvents.find((event) => event.entityKind === "message");
    expect(realtimeMessage?.id).toBe(snapshotMessage?.id);
    expect(realtimeMessage?.dedupeKey).toBe(snapshotMessage?.dedupeKey);
    expect(realtimeMessage).toEqual(buildSignalMessageEvent(message, "default", 100));
  });

  it("preserves zero-byte signal attachment sizes", () => {
    const message = {
      messageId: "msg-attachment-1",
      threadId: "dm:+14155550123",
      threadType: "dm" as const,
      text: "Attachment",
      sentAt: 1_710_000_000_000,
      isFromMe: false,
      senderHandle: "+14155550123",
      senderName: "Ben Ortiz",
      peerHandle: "+14155550123",
      attachments: [
        {
          id: "att-1",
          filename: "empty.txt",
          contentType: "text/plain",
          size: 0,
          path: "/tmp/empty.txt",
        },
      ],
    };

    const event = buildSignalMessageEvent(message, "default", 100);
    const attachments = (event.payload as { attachments?: Array<Record<string, unknown>> })
      .attachments;

    expect(attachments).toEqual([
      expect.objectContaining({
        id: "att-1",
        size_bytes: 0,
        local_path: "/tmp/empty.txt",
      }),
    ]);
  });

  it("preserves mixed-case Signal group ids in conversation and message keys", () => {
    const groupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const message = {
      messageId: "msg-group-1",
      threadId: `group:${groupId}`,
      threadType: "group" as const,
      threadName: "Launch Group",
      text: "Group hello",
      sentAt: 1_710_000_000_000,
      isFromMe: false,
      senderHandle: "+14155550123",
      senderName: "Ben Ortiz",
      attachments: [],
    };

    const events = buildSignalRawEventsFromSnapshot({
      accountKey: "default",
      contacts: [],
      groups: [
        {
          groupId,
          name: "Launch Group",
          members: [{ number: "+14155550123" }],
        },
      ],
      messages: [message],
      observedBase: 100,
    });

    const conversationKeys = events
      .filter((event) => event.entityKind === "conversation")
      .map((event) => (event.payload as { sourceConversationKey?: string }).sourceConversationKey);
    expect(conversationKeys).toContain(`signal:group:${groupId}`);

    const messageEvent = events.find((event) => event.entityKind === "message");
    expect(messageEvent?.conversationExternalId).toBe(`group:${groupId}`);
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        sourceConversationKey: `signal:group:${groupId}`,
      }),
    );
  });
});
