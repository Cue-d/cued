import { describe, expect, it } from "vitest";
import {
  addWhatsAppResyncStats,
  buildWhatsAppMessagesProof,
  mergeWhatsAppResyncCoverage,
  parseWhatsAppSourceCursor,
  summarizeWhatsAppMessageCoverage,
} from "./proof.js";

describe("WhatsApp sync proof helpers", () => {
  it("preserves full-sync mode and aggregate state across resumed cursors", () => {
    const parsed = parseWhatsAppSourceCursor({
      lastSyncAt: 100,
      resyncCursor: "cursor-2",
      resyncSinceMs: null,
      resyncStartedAt: 200,
      resyncSyncMode: "full",
      resyncStats: {
        pageCount: 1,
        contactCount: 2,
        chatCount: 3,
        messageCount: 1000,
        rawEventCount: 1005,
      },
      resyncCoverage: {
        oldestMessageAt: 10,
        newestMessageAt: 20,
      },
    });

    expect(parsed.resyncSyncMode).toBe("full");
    expect(
      addWhatsAppResyncStats(parsed.resyncStats!, {
        pageCount: 1,
        contactCount: 0,
        chatCount: 1,
        messageCount: 250,
        rawEventCount: 251,
      }),
    ).toEqual({
      pageCount: 2,
      contactCount: 2,
      chatCount: 4,
      messageCount: 1250,
      rawEventCount: 1256,
    });
  });

  it("builds complete proof coverage from all resumed pages", () => {
    const firstCoverage = summarizeWhatsAppMessageCoverage([
      {
        messageID: "m1",
        chatJID: "15551234567@s.whatsapp.net",
        fromMe: false,
        timestamp: 30,
        text: "later",
      },
    ]);
    const resumedCoverage = summarizeWhatsAppMessageCoverage([
      {
        messageID: "m2",
        chatJID: "15551234567@s.whatsapp.net",
        fromMe: false,
        timestamp: 10,
        text: "earlier",
      },
    ]);
    const coverage = mergeWhatsAppResyncCoverage(firstCoverage, resumedCoverage);

    const proof = buildWhatsAppMessagesProof({
      accountKey: "default",
      syncMode: "full",
      observedAt: 500,
      runStartedAt: 100,
      hasMore: false,
      nextCursor: null,
      sinceMs: null,
      completedAt: 500,
      stats: {
        pageCount: 2,
        contactCount: 0,
        chatCount: 1,
        messageCount: 2,
        rawEventCount: 3,
      },
      coverage,
    });

    expect(proof.status).toBe("complete");
    expect(proof.syncMode).toBe("full");
    expect(proof.resumeCursor).toBeNull();
    expect(proof.coverage).toMatchObject({
      oldestMessageAt: 10,
      newestMessageAt: 30,
      snapshotCompletedAt: 500,
    });
    expect(proof.stats).toEqual({
      pageCount: 2,
      contactCount: 0,
      chatCount: 1,
      messageCount: 2,
      rawEventCount: 3,
    });
  });
});
