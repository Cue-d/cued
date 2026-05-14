import { describe, expect, it } from "vitest";
import {
  addWhatsAppResyncStats,
  buildWhatsAppMessagesProof,
  DEFAULT_WHATSAPP_DESKTOP_HELPER_OVERLAP_MS,
  mergeWhatsAppResyncCoverage,
  parseWhatsAppSourceCursor,
  selectWhatsAppHelperSinceMs,
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
      desktopDb: {
        importedAt: 300,
        sourcePath: "/Users/example/Library/Group Containers/group.net.whatsapp.WhatsApp.shared",
        chatRows: 4,
        contactRows: 5,
        messageRows: 6,
        oldestMessageAt: 10,
        newestMessageAt: 20,
      },
    });

    expect(parsed.resyncSyncMode).toBe("full");
    expect(parsed.desktopDb).toMatchObject({
      importedAt: 300,
      chatRows: 4,
      contactRows: 5,
      messageRows: 6,
      oldestMessageAt: 10,
      newestMessageAt: 20,
    });
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

  it("starts helper sync from desktop coverage with overlap when no helper cursor exists", () => {
    const desktopNewest = 1_800_000_000_000;
    const parsed = parseWhatsAppSourceCursor({
      desktopDb: {
        newestMessageAt: desktopNewest,
      },
    });

    expect(
      selectWhatsAppHelperSinceMs({
        cursor: null,
        sourceCursor: parsed,
        syncMode: "incremental",
        checkpointLastSuccessAt: desktopNewest + 60_000,
      }),
    ).toBe(desktopNewest - DEFAULT_WHATSAPP_DESKTOP_HELPER_OVERLAP_MS);
  });

  it("prefers helper progress over desktop coverage after realtime sync has run", () => {
    const parsed = parseWhatsAppSourceCursor({
      lastSyncAt: 1_800_000_000_000,
      desktopDb: {
        newestMessageAt: 1_700_000_000_000,
      },
    });

    expect(
      selectWhatsAppHelperSinceMs({
        cursor: null,
        sourceCursor: parsed,
        syncMode: "incremental",
        checkpointLastSuccessAt: 1_900_000_000_000,
      }),
    ).toBe(1_800_000_000_000);
  });

  it("keeps the original since timestamp while a paginated helper resync is running", () => {
    const parsed = parseWhatsAppSourceCursor({
      resyncCursor: "cursor-2",
      resyncSinceMs: 1_600_000_000_000,
      desktopDb: {
        newestMessageAt: 1_700_000_000_000,
      },
    });

    expect(
      selectWhatsAppHelperSinceMs({
        cursor: parsed.resyncCursor ?? null,
        sourceCursor: parsed,
        syncMode: "incremental",
        checkpointLastSuccessAt: 1_900_000_000_000,
      }),
    ).toBe(1_600_000_000_000);
  });

  it("builds complete proof coverage from all resumed pages", () => {
    const firstCoverage = summarizeWhatsAppMessageCoverage([
      {
        messageID: "m1",
        chatJID: "15550100002@s.whatsapp.net",
        fromMe: false,
        timestamp: 30,
        text: "later",
      },
    ]);
    const resumedCoverage = summarizeWhatsAppMessageCoverage([
      {
        messageID: "m2",
        chatJID: "15550100002@s.whatsapp.net",
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
