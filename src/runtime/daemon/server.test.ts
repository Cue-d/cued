import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  buildSyncResumeTargets,
  dispatchRequest,
  isDisconnectedSocketError,
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
      () => {},
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
    username: "theo",
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
            account_key: "theo@example.com",
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
        accountKey: "theo@example.com",
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
