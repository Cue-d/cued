import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  buildSyncResumeTargets,
  buildWhatsAppRealtimeSnapshotFromEvent,
  dispatchRequest,
  getAdaptiveProjectionBatchSize,
  getAdaptiveProjectionContinueDelayMs,
  getAutoSyncTargets,
  InteractiveAuthSessions,
  isDisconnectedSocketError,
  requestWhatsAppHistoryBackfillOnce,
  shouldDeferContinuationProjection,
  shouldDrainOutboundQueue,
  shouldProjectIngestRunInline,
  shouldSkipConnectedDiscordSchedulerSync,
} from "./server.js";

function createDispatchHarness() {
  const dir = mkdtempSync(join(tmpdir(), "cued-daemon-actions-"));
  const db = new CuedDatabase(join(dir, "local.db"));
  db.initializeSchema();
  const schedulers = {
    wakeIngest: () => {},
    wakeProjection: () => {},
    wakeOutbound: () => {},
    wakeSearchIndex: () => {},
  };
  const realtime = {
    getStatus: () => null,
    ensureDesiredSessions: async () => {},
    shutdown: async () => {},
  };
  const bootstrap = {
    state: "ready",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    error: null,
  };
  const authRuntimeStatus = {
    active: false,
    expiresAt: null,
    projectionBatchSize: 500,
    ingestConcurrency: 2,
  };
  const dispatch = (request: Parameters<typeof dispatchRequest>[1]) =>
    dispatchRequest(
      db,
      request,
      new Map(),
      schedulers as never,
      realtime as never,
      realtime as never,
      realtime as never,
      realtime as never,
      realtime as never,
      bootstrap as never,
      () => {},
      () => {},
      () => ({ shuttingDown: false, requestedAt: null }),
      () => false,
      () => {},
      () => authRuntimeStatus,
      () => authRuntimeStatus,
      () => {},
      () => {},
      () => true,
    );
  return {
    db,
    dispatch,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("discord scheduler pacing", () => {
  const connectedStatus = {
    platform: "discord" as const,
    accountKey: "default",
    state: "connected" as const,
    userId: "u-self",
    username: "avery",
    connectedAt: 1,
    lastEventAt: 1,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  };

  it("skips scheduler syncs while discord realtime is connected", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", connectedStatus)).toBe(
      true,
    );
  });

  it("does not skip non-scheduler or degraded discord runs", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "cli", connectedStatus)).toBe(false);
    expect(
      shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", {
        ...connectedStatus,
        state: "degraded",
      }),
    ).toBe(false);
  });

  it("does not affect other platforms", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("slack", "scheduler", connectedStatus)).toBe(
      false,
    );
  });
});

describe("outbound send gate", () => {
  it("does not drain queued outbound rows unless outbound send is enabled", () => {
    expect(
      shouldDrainOutboundQueue({
        outboundSendEnabled: false,
        isUpdateShutdownRequested: false,
        activeOutboundSend: null,
      }),
    ).toBe(false);

    expect(
      shouldDrainOutboundQueue({
        outboundSendEnabled: true,
        isUpdateShutdownRequested: false,
        activeOutboundSend: null,
      }),
    ).toBe(true);
  });

  it("does not drain while shutdown or another outbound send is active", () => {
    expect(
      shouldDrainOutboundQueue({
        outboundSendEnabled: true,
        isUpdateShutdownRequested: true,
        activeOutboundSend: null,
      }),
    ).toBe(false);

    expect(
      shouldDrainOutboundQueue({
        outboundSendEnabled: true,
        isUpdateShutdownRequested: false,
        activeOutboundSend: Promise.resolve(),
      }),
    ).toBe(false);
  });
});

describe("ingest projection strategy", () => {
  it("defers discord sync projection so run completion is not coupled to projection", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "discord",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 373,
        insertedRawEvents: 373,
      }),
    ).toBe(false);
  });

  it("keeps inline projection only for small non-resume batches when enabled", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(true);
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        runType: "sync",
        realtimeProjectionEnabled: false,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(false);
    expect(
      shouldProjectIngestRunInline({
        platform: "imessage",
        runType: "sync_resume",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(false);
    expect(
      shouldProjectIngestRunInline({
        platform: "imessage",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 2_000,
        insertedRawEvents: 2_000,
      }),
    ).toBe(false);
  });
});

describe("daemon socket errors", () => {
  it("classifies disconnected clients as non-fatal IPC errors", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      expect(isDisconnectedSocketError(error)).toBe(true);
    }
  });

  it("does not hide unexpected socket errors", () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isDisconnectedSocketError(error)).toBe(false);
    expect(isDisconnectedSocketError("EPIPE")).toBe(false);
  });
});

describe("whatsapp realtime event routing", () => {
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

describe("adaptive projection scheduling", () => {
  it("coalesces only small continuation projection backlogs inside the interval", () => {
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(true);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 500,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 3_001,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: false,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 0,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
  });

  it("uses larger batches for large backlogs", () => {
    expect(getAdaptiveProjectionBatchSize(0)).toBe(100);
    expect(getAdaptiveProjectionBatchSize(1_000)).toBe(500);
    expect(getAdaptiveProjectionBatchSize(5_000)).toBe(1_000);
    expect(getAdaptiveProjectionBatchSize(25_000)).toBe(1_500);
    expect(getAdaptiveProjectionBatchSize(100_000)).toBe(2_000);
  });

  it("caps adaptive batches during interactive auth", () => {
    expect(getAdaptiveProjectionBatchSize(100_000, { maxBatchSize: 25 })).toBe(25);
    expect(getAdaptiveProjectionBatchSize(1_000, { maxBatchSize: 25 })).toBe(25);
    expect(getAdaptiveProjectionBatchSize(0, { maxBatchSize: 25 })).toBe(25);
  });

  it("removes continuation delay only while backlog is large", () => {
    expect(getAdaptiveProjectionContinueDelayMs(999)).toBe(5_000);
    expect(getAdaptiveProjectionContinueDelayMs(5_000)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(25_000)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(100_000)).toBe(0);
  });
});

describe("interactive auth sessions", () => {
  it("keeps interaction mode active when an unrelated session ends", () => {
    const nowMs = 1_000;
    const sessions = new InteractiveAuthSessions(() => nowMs);

    expect(sessions.begin("screen-a", 30_000)).toEqual({
      active: true,
      expiresAt: 31_000,
    });
    expect(sessions.end("wrong")).toEqual({
      active: true,
      expiresAt: 31_000,
    });
    expect(sessions.end("screen-a")).toEqual({
      active: false,
      expiresAt: null,
    });
  });

  it("expires interaction sessions by ttl", () => {
    let nowMs = 1_000;
    const sessions = new InteractiveAuthSessions(() => nowMs);

    sessions.begin("screen-a", 30_000);
    nowMs = 31_000;

    expect(sessions.status()).toEqual({
      active: false,
      expiresAt: null,
    });
  });

  it("tracks the latest expiry across overlapping sessions", () => {
    const nowMs = 1_000;
    const sessions = new InteractiveAuthSessions(() => nowMs);

    sessions.begin("screen-a", 30_000);
    sessions.begin("connect:slack:default", 45_000);

    expect(sessions.end("screen-a")).toEqual({
      active: true,
      expiresAt: 46_000,
    });
  });
});

describe("daemon action requests", () => {
  it("proposes actions through dispatch", async () => {
    const harness = createDispatchHarness();
    try {
      const response = await harness.dispatch({
        id: "actions-propose",
        command: "actions-propose",
        actionType: "contact.message.draft",
        payload: {
          contactId: "contact-1",
          body: "Following up on our last thread.",
          reason: "Recent inbound message has no newer outbound reply.",
        },
        title: "Draft follow-up",
        createdBy: "daemon-test",
      });

      expect(response).toMatchObject({
        id: "actions-propose",
        ok: true,
        result: {
          action_type: "contact.message.draft",
          status: "proposed",
          approval_status: "pending",
          title: "Draft follow-up",
          source_skill: "cued",
          created_by: "daemon-test",
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("approves and executes actions through dispatch", async () => {
    const harness = createDispatchHarness();
    try {
      const action = harness.db.createAction({
        actionType: "contact.memory.stale",
        payload: { memoryId: "missing-memory" },
      });

      const listResponse = await harness.dispatch({
        id: "actions-list",
        command: "actions-list",
        status: "proposed",
      });
      expect(listResponse).toMatchObject({
        id: "actions-list",
        ok: true,
      });
      expect(listResponse.result).toEqual([expect.objectContaining({ id: action.id })]);

      const approveResponse = await harness.dispatch({
        id: "actions-approve",
        command: "actions-approve",
        actionId: action.id,
        approvedBy: "soham",
      });
      expect(approveResponse.result).toMatchObject({
        id: action.id,
        status: "approved",
        approved_by: "soham",
      });

      const executeResponse = await harness.dispatch({
        id: "actions-execute",
        command: "actions-execute",
        actionId: action.id,
        executedBy: "daemon-test",
      });
      expect(executeResponse).toMatchObject({
        id: "actions-execute",
        ok: false,
        error: "Contact memory not found: missing-memory",
      });
      expect(harness.db.getAction(action.id)).toMatchObject({
        status: "failed",
        execution_status: "failed",
        executed_by: "daemon-test",
      });
    } finally {
      harness.cleanup();
    }
  });

  it("runs approved actions through dispatch", async () => {
    const harness = createDispatchHarness();
    try {
      const action = harness.db.createAction({
        actionType: "contact.memory.stale",
        payload: { memoryId: "missing-memory" },
        requiresApproval: false,
      });

      const response = await harness.dispatch({
        id: "actions-run-approved",
        command: "actions-run-approved",
        limit: 10,
        executedBy: "daemon-test",
      });

      expect(response).toMatchObject({
        id: "actions-run-approved",
        ok: true,
        result: {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          results: [
            {
              actionId: action.id,
              ok: false,
              error: "Contact memory not found: missing-memory",
            },
          ],
        },
      });
      expect(harness.db.getAction(action.id)).toMatchObject({
        status: "failed",
        execution_status: "failed",
      });
    } finally {
      harness.cleanup();
    }
  });
});

describe("sync resume targets", () => {
  it("allows autosync to be explicitly disabled", () => {
    const previous = process.env.CUED_AUTOSYNC_PLATFORMS;
    process.env.CUED_AUTOSYNC_PLATFORMS = "none";
    try {
      expect(
        getAutoSyncTargets({
          listEnabledSyncTargets: () => [
            {
              platform: "imessage",
              account_key: "local",
            },
          ],
          listIntegrationStates: () => [],
        }),
      ).toEqual([]);
    } finally {
      if (previous == null) {
        delete process.env.CUED_AUTOSYNC_PLATFORMS;
      } else {
        process.env.CUED_AUTOSYNC_PLATFORMS = previous;
      }
    }
  });

  it("preserves account keys that contain colons", () => {
    expect(
      buildSyncResumeTargets({
        listEnabledSyncTargets: () => [
          {
            platform: "slack",
            account_key: "workspace:team",
          },
        ],
        listIntegrationStates: () => [],
        listCheckpointTargets: () => [
          {
            platform: "gmail",
            account_key: "avery@example.com",
          },
        ],
      }),
    ).toEqual([
      {
        platform: "slack",
        accountKey: "workspace:team",
      },
      {
        platform: "gmail",
        accountKey: "avery@example.com",
      },
    ]);
  });

  it("does not fall back to unauthenticated default targets after integration state exists", () => {
    expect(
      buildSyncResumeTargets({
        listEnabledSyncTargets: () => [],
        listIntegrationStates: () => [{ platform: "contacts" }] as never,
        listCheckpointTargets: () => [],
      }),
    ).toEqual([]);
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
