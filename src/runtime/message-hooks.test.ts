import { describe, expect, it } from "vitest";
import { collectInboundMessageHookPayloads } from "./message-hooks.js";

function isInboundMessageEvent(event: Record<string, unknown>): boolean {
  const payload = event.payload as { isFromMe?: boolean };
  return (
    event.entityKind === "message" && event.eventKind === "created" && payload.isFromMe !== true
  );
}

describe("collectInboundMessageHookPayloads", () => {
  it("includes acquisitionMode for realtime inbound messages", () => {
    const payloads = collectInboundMessageHookPayloads(
      "run-1",
      [
        {
          rowId: 12,
          event: {
            id: "event-1",
            platform: "slack",
            accountKey: "acct",
            entityKind: "message",
            eventKind: "created",
            observedAt: 123,
            dedupeKey: "dedupe-1",
            payload: { isFromMe: false, text: "hello" },
            provenance: { acquisitionMode: "realtime" },
          },
        },
      ],
      isInboundMessageEvent,
    );

    expect(payloads).toEqual([
      {
        rowId: 12,
        payload: {
          runId: "run-1",
          message: {
            platform: "slack",
            accountKey: "acct",
            observedAt: 123,
            acquisitionMode: "realtime",
            payload: { isFromMe: false, text: "hello" },
          },
        },
      },
    ]);
  });

  it("includes acquisitionMode for sync-imported inbound messages and skips outbound ones", () => {
    const payloads = collectInboundMessageHookPayloads(
      "run-2",
      [
        {
          rowId: 21,
          event: {
            id: "event-2",
            platform: "whatsapp",
            accountKey: "acct",
            entityKind: "message",
            eventKind: "created",
            observedAt: 456,
            dedupeKey: "dedupe-2",
            payload: { isFromMe: false, text: "history" },
            provenance: { acquisitionMode: "sync" },
          },
        },
        {
          rowId: 22,
          event: {
            id: "event-3",
            platform: "whatsapp",
            accountKey: "acct",
            entityKind: "message",
            eventKind: "created",
            observedAt: 789,
            dedupeKey: "dedupe-3",
            payload: { isFromMe: true, text: "ignore me" },
            provenance: { acquisitionMode: "realtime" },
          },
        },
      ],
      isInboundMessageEvent,
    );

    expect(payloads).toEqual([
      {
        rowId: 21,
        payload: {
          runId: "run-2",
          message: {
            platform: "whatsapp",
            accountKey: "acct",
            observedAt: 456,
            acquisitionMode: "sync",
            payload: { isFromMe: false, text: "history" },
          },
        },
      },
    ]);
  });
});
