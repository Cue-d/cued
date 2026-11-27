import { describe, expect, it } from "vitest";
import {
  buildWhatsAppRealtimeSnapshotFromEvent,
  requestWhatsAppHistoryBackfillOnce,
} from "./whatsapp-sync.js";

describe("whatsapp realtime event routing", () => {
  it("preserves authenticated identity aliases for projection", () => {
    const identityAliases = [{ lid: "123@lid", pn: "1555@s.whatsapp.net" }];
    expect(
      buildWhatsAppRealtimeSnapshotFromEvent({
        event: "history_sync",
        identityAliases,
        data: { contacts: [{ jid: "123@lid" }] },
      }),
    ).toEqual({ identityAliases, contacts: [{ jid: "123@lid" }] });
  });
  it("turns call_upsert events into ingestible realtime snapshots", () => {
    expect(
      buildWhatsAppRealtimeSnapshotFromEvent({
        event: "call_upsert",
        data: {
          callID: "call-1",
          chatJID: "12016824050@s.whatsapp.net",
          remoteJID: "12016824050@s.whatsapp.net",
          fromMe: true,
          timestamp: 1_710_000_000_000,
          durationSeconds: 61,
          status: "completed",
          medium: "audio",
        },
      }),
    ).toEqual({
      calls: [
        {
          callID: "call-1",
          chatJID: "12016824050@s.whatsapp.net",
          remoteJID: "12016824050@s.whatsapp.net",
          fromMe: true,
          timestamp: 1_710_000_000_000,
          durationSeconds: 61,
          status: "completed",
          medium: "audio",
        },
      ],
    });
  });
});

describe("WhatsApp history backfill", () => {
  const anchors = [
    {
      chatJID: "15550100001@s.whatsapp.net",
      messageID: "wamid-1",
      timestamp: 1_700_000_000_000,
      fromMe: false,
    },
  ];

  it("records the backfill marker only after a helper request succeeds", async () => {
    await expect(
      requestWhatsAppHistoryBackfillOnce({
        anchors,
        nowMs: () => 123,
        request: async () => ({
          requested: 1,
          failed: 0,
          queuedHistorySyncCount: 1,
          lastHistorySyncAt: null,
          lastHistoryNotificationAt: 122,
        }),
      }),
    ).resolves.toEqual({
      historyBackfillRequestedAt: 123,
      diagnostics: {
        requested: 1,
        failed: 0,
        queuedHistorySyncCount: 1,
        lastHistorySyncAt: null,
        lastHistoryNotificationAt: 122,
        errors: [],
      },
    });
  });

  it("leaves the backfill marker unset when the helper request fails", async () => {
    await expect(
      requestWhatsAppHistoryBackfillOnce({
        anchors,
        nowMs: () => 123,
        request: async () => {
          throw new Error("helper timed out");
        },
      }),
    ).resolves.toEqual({
      historyBackfillRequestedAt: null,
      diagnostics: {
        requested: 0,
        failed: 1,
        error: "helper timed out",
      },
    });
  });
});
