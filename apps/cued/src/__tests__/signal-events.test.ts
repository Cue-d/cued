import { describe, expect, it } from "vitest";
import {
  buildOptimisticSignalRawEvents,
  buildSignalMessageEvent,
  buildSignalRawEventsFromMessages,
  buildSignalRawEventsFromSnapshot,
} from "../integrations/signal-events.js";
import { toSignalMessage } from "../integrations/signal-cli.js";

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

  it("uses the same message key for optimistic sent messages and later sync echoes", () => {
    const optimisticEvents = buildOptimisticSignalRawEvents({
      accountKey: "default",
      recipientHandle: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadId: "dm:d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadName: "Soham Bafana",
      text: "test from Cued via signal_id",
      sentAt: 1_710_000_000_000,
      observedAt: 200,
    });
    const optimisticMessage = optimisticEvents.find((event) => event.entityKind === "message");

    const echoed = toSignalMessage({
      envelope: {
        timestamp: 1_710_000_000_000,
        syncMessage: {
          sentMessage: {
            timestamp: 1_710_000_000_000,
            message: "test from Cued via signal_id",
            destinationUuid: "d6ed1597-758c-4022-96aa-253b334f1f5d",
          },
        },
      },
    }, "+13474468966", 0);

    expect(echoed).not.toBeNull();
    const echoedEvents = buildSignalRawEventsFromMessages({
      accountKey: "default",
      messages: [echoed!],
      observedBase: 201,
    });
    const echoedMessage = echoedEvents.find((event) => event.entityKind === "message");

    expect((optimisticMessage?.payload as { sourceMessageKey?: string }).sourceMessageKey).toBe(
      (echoedMessage?.payload as { sourceMessageKey?: string }).sourceMessageKey,
    );
  });
});
