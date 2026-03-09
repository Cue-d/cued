import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";

describe("CuedDatabase", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("creates the schema and exposes overview counts", () => {
    const db = createDb();
    expect(db.getOverview()).toEqual({
      contacts: 0,
      conversations: 0,
      messages: 0,
      rawEvents: 0,
      sourceAccounts: 0,
      integrations: 0,
      authSessions: 0,
    });
    db.close();
  });

  it("stores daemon state and manual merge decisions", () => {
    const db = createDb();

    db.upsertDaemonState({
      pid: 42,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      status: "running",
      version: "0.1.0",
      details: { source: "test" },
    });

    expect(db.getDaemonState()).toEqual({
      singleton_key: "daemon",
      pid: 42,
      started_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_500,
      status: "running",
      version: "0.1.0",
      details_json: JSON.stringify({ source: "test" }),
    });

    const id = db.insertMergeDecision({
      decisionType: "merge",
      leftContactId: "contact-a",
      rightContactId: "contact-b",
      canonicalContactId: "contact-a",
      createdBy: "cli",
    });

    expect(id).toBeTruthy();
    db.close();
  });

  it("manages integration states", () => {
    const db = createDb();

    db.upsertIntegrationState({
      platform: "linkedin",
      accountKey: "default",
      displayName: "LinkedIn",
      authState: "authorized",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      metadata: { source: "test" },
    });

    expect(db.listEnabledSyncPlatforms()).toEqual(["linkedin"]);
    expect(db.getIntegrationState("linkedin", "default")).toEqual(
      expect.objectContaining({
        platform: "linkedin",
        account_key: "default",
        auth_state: "authorized",
        enabled: 1,
        sync_capable: 1,
        metadata_json: JSON.stringify({ source: "test" }),
      }),
    );

    db.setIntegrationEnabled("linkedin", "default", false);
    expect(db.listIntegrationStates()).toEqual([
      expect.objectContaining({
        platform: "linkedin",
        account_key: "default",
        enabled: 0,
      }),
    ]);

    db.close();
  });

  it("tracks auth sessions independently from integration state", () => {
    const db = createDb();

    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "workspace-a",
      displayName: "Slack Workspace A",
      authState: "requested",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "native-auth",
      launchTarget: "https://slack.com/signin",
    });

    const sessionId = db.createAuthSession({
      platform: "slack",
      accountKey: "workspace-a",
      integrationStateId: "slack:workspace-a",
      state: "requested",
    });

    db.updateAuthSessionState({
      id: sessionId,
      state: "authenticated",
      nativePid: null,
      startedAt: 10,
      finishedAt: 20,
      keychainService: "dev.cued.auth.slack",
      keychainAccount: "workspace-a",
      resultSummary: { teamId: "T123" },
    });

    expect(db.getOverview().authSessions).toBe(1);
    expect(db.getAuthSession(sessionId)).toEqual(
      expect.objectContaining({
        id: sessionId,
        state: "authenticated",
        keychain_service: "dev.cued.auth.slack",
        keychain_account: "workspace-a",
        result_summary_json: JSON.stringify({ teamId: "T123" }),
      }),
    );
    expect(db.getLatestAuthSession("slack", "workspace-a")?.id).toBe(sessionId);

    db.close();
  });

  it("queues, claims, and finishes sync runs", () => {
    const db = createDb();

    const runId = db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "manual",
      details: { requestId: "abc" },
    });

    expect(db.hasQueuedOrRunningRun("contacts")).toBe(true);
    expect(db.listRecentRuns(1)).toEqual([
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "queued",
      }),
    ]);

    expect(db.claimNextQueuedRun()).toEqual(
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "ingesting",
        details_json: JSON.stringify({ requestId: "abc" }),
      }),
    );

    db.finishRun(runId, { projected: 3 });
    expect(db.listRecentRuns(1)[0]).toEqual(
      expect.objectContaining({
        id: runId,
        status: "completed",
      }),
    );

    const failedId = db.queueSyncRun({
      platform: "linkedin",
      accountKey: "default",
      runType: "sync",
      trigger: "manual",
    });
    db.failRun(failedId, "boom", { code: "x" });
    expect(db.listRecentRuns(2).some((run) => run.id === failedId && run.status === "failed")).toBe(true);

    db.close();
  });

  it("stores checkpoints and raw events", () => {
    const db = createDb();

    db.upsertSourceAccount({
      platform: "contacts",
      accountKey: "local",
      displayName: "macOS Contacts",
    });
    db.upsertCheckpoint({
      platform: "contacts",
      accountKey: "local",
      syncMode: "full",
      sourceCursor: { snapshotAt: 123 },
      rawIngestWatermark: 5,
      projectionWatermark: 3,
      lastSuccessAt: 1_700_000_000_000,
    });
    db.upsertCheckpoint({
      platform: "contacts",
      accountKey: "local",
      syncMode: "incremental",
      sourceCursor: { snapshotAt: 456 },
      rawIngestWatermark: 6,
      projectionWatermark: 4,
      lastSuccessAt: 1_700_000_000_500,
      lastErrorSummary: "none",
    });

    const rawEventId = randomUUID();
    db.insertRawEvent({
      id: rawEventId,
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1_700_000_000_000,
      dedupeKey: "contacts:1",
      payload: { hello: "world" },
      sourceVersion: "contacts-v1",
    });

    expect(db.getCheckpoint("contacts", "local")).toEqual({
      source_cursor_json: JSON.stringify({ snapshotAt: 456 }),
      sync_mode: "incremental",
      raw_ingest_watermark: 6,
      projection_watermark: 4,
    });
    expect(db.listCheckpointSummary()).toEqual([
      {
        platform: "contacts",
        account_key: "local",
        sync_mode: "incremental",
        last_success_at: 1_700_000_000_500,
        last_error_summary: "none",
      },
    ]);
    expect(db.listCheckpointPlatforms()).toEqual(["contacts"]);
    expect(db.listRawEvents()).toEqual([
      {
        id: rawEventId,
        platform: "contacts",
        account_key: "local",
        entity_kind: "contact",
        event_kind: "observed",
        observed_at: 1_700_000_000_000,
        payload_json: JSON.stringify({ hello: "world" }),
      },
    ]);

    expect(db.getProjectionState()).toEqual({
      singleton_key: "global",
      projection_watermark: 0,
      last_projected_at: null,
      last_rebuild_at: null,
      updated_at: expect.any(Number),
    });
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 1,
      pending_raw_events: 1,
    });

    db.close();
  });
});
