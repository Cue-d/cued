import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { MIGRATIONS } from "../db/migrations.js";

describe("CuedDatabase", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function insertContact(
    db: CuedDatabase,
    input: {
      id: string;
      name: string;
      updatedAt?: number;
    },
  ): void {
    const sqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
    const timestamp = input.updatedAt ?? Date.now();
    sqlite
      .prepare(
        `
      INSERT INTO contacts (id, kind, name, photo_url, company, archived, created_at, updated_at)
      VALUES (?, 'person', ?, NULL, NULL, 0, ?, ?)
    `,
      )
      .run(input.id, input.name, timestamp, timestamp);
  }

  function insertHandle(
    db: CuedDatabase,
    input: {
      id: string;
      contactId: string;
      type: string;
      value: string;
      normalizedValue: string;
      platform: string;
      accountKey: string;
      isDeterministic?: number;
    },
  ): void {
    const sqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
    const timestamp = Date.now();
    sqlite
      .prepare(
        `
      INSERT INTO contact_handles (
        id, contact_id, type, value, normalized_value, platform, account_key, is_deterministic, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.id,
        input.contactId,
        input.type,
        input.value,
        input.normalizedValue,
        input.platform,
        input.accountKey,
        input.isDeterministic ?? 1,
        timestamp,
        timestamp,
      );
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

  it("persists app settings and install metadata", () => {
    const db = createDb();

    db.recordAppMetadata({
      version: "0.1.0-internal.1",
      releaseChannel: "internal",
      cliSymlinkInstalled: true,
    });
    db.markOnboardingCompleted("0.1.0-internal.1");
    db.markReleaseCheck(123456789);

    expect(db.getAppMetadata()).toEqual({
      onboardingCompletedVersion: "0.1.0-internal.1",
      releaseChannel: "internal",
      installedAppVersion: "0.1.0-internal.1",
      lastReleaseCheckAt: 123456789,
      cliSymlinkInstalled: true,
      updateReleaseState: null,
      updatePendingRollback: null,
      updateLastError: null,
    });
    expect(db.getAppSetting("installed_app_version")?.value).toBe("0.1.0-internal.1");

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

  it("queues and retries outbound messages", () => {
    const db = createDb();

    const messageId = db.queueOutboundMessage({
      platform: "signal",
      accountKey: "default",
      target: "+14155550123",
      text: "Hello",
    });

    const claimed = db.claimNextOutboundMessage("signal");
    expect(claimed).toEqual(
      expect.objectContaining({
        id: messageId,
        platform: "signal",
        account_key: "default",
        status: "sending",
        attempt_count: 1,
      }),
    );

    db.failOutboundMessage({
      id: messageId,
      retryable: true,
      error: "network timeout",
      retryDelayMs: 0,
    });
    expect(db.hasQueuedOutboundMessages("signal")).toBe(true);

    const retried = db.claimNextOutboundMessage("signal");
    expect(retried?.attempt_count).toBe(2);
    db.completeOutboundMessage(messageId);
    expect(db.hasQueuedOutboundMessages("signal")).toBe(false);
    db.close();
  });

  it("resolves Signal targets by preferring signal_id over phone without merging contacts", () => {
    const db = createDb();

    insertContact(db, { id: "contact-phone", name: "Soham Bafana", updatedAt: 10 });
    insertContact(db, { id: "contact-signal", name: "Soham Bafana", updatedAt: 20 });

    insertHandle(db, {
      id: "handle-phone",
      contactId: "contact-phone",
      type: "phone",
      value: "+12016824050",
      normalizedValue: "+12016824050",
      platform: "contacts",
      accountKey: "local",
    });
    insertHandle(db, {
      id: "handle-signal",
      contactId: "contact-signal",
      type: "signal_id",
      value: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      normalizedValue: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      platform: "signal",
      accountKey: "default",
    });

    expect(db.resolveSignalSendTarget("Soham Bafana")).toEqual({
      target: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadId: "dm:d6ed1597-758c-4022-96aa-253b334f1f5d",
      resolution: "signal_id",
      matchedContactIds: ["contact-signal", "contact-phone"],
      matchedName: "Soham Bafana",
    });

    expect(db.resolveSignalSendTarget("+12016824050")).toEqual({
      target: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadId: "dm:d6ed1597-758c-4022-96aa-253b334f1f5d",
      resolution: "signal_id",
      matchedContactIds: ["contact-phone", "contact-signal"],
      matchedName: "Soham Bafana",
    });

    db.close();
  });

  it("keeps direct Signal phone sends as passthrough when there is no better contact match", () => {
    const db = createDb();

    expect(db.resolveSignalSendTarget("+14155550123")).toEqual({
      target: "+14155550123",
      threadId: "dm:+14155550123",
      resolution: "passthrough",
      matchedContactIds: [],
      matchedName: null,
    });

    db.close();
  });

  it("resolves WhatsApp targets by preferring whatsapp_jid over phone without merging contacts", () => {
    const db = createDb();

    insertContact(db, { id: "contact-phone", name: "Soham Bafana", updatedAt: 10 });
    insertContact(db, { id: "contact-whatsapp", name: "Soham Bafana", updatedAt: 20 });

    insertHandle(db, {
      id: "wa-handle-phone",
      contactId: "contact-phone",
      type: "phone",
      value: "+12016824050",
      normalizedValue: "+12016824050",
      platform: "contacts",
      accountKey: "local",
    });
    insertHandle(db, {
      id: "wa-handle-jid",
      contactId: "contact-whatsapp",
      type: "whatsapp_jid",
      value: "12016824050@s.whatsapp.net",
      normalizedValue: "12016824050@s.whatsapp.net",
      platform: "whatsapp",
      accountKey: "default",
    });

    expect(db.resolveWhatsAppSendTarget("Soham Bafana")).toEqual({
      target: "12016824050@s.whatsapp.net",
      threadId: "dm:12016824050@s.whatsapp.net",
      resolution: "whatsapp_jid",
      matchedContactIds: ["contact-whatsapp", "contact-phone"],
      matchedName: "Soham Bafana",
    });

    expect(db.resolveWhatsAppSendTarget("+12016824050")).toEqual({
      target: "12016824050@s.whatsapp.net",
      threadId: "dm:12016824050@s.whatsapp.net",
      resolution: "whatsapp_jid",
      matchedContactIds: ["contact-phone", "contact-whatsapp"],
      matchedName: "Soham Bafana",
    });

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
    const queuedRun = db.listRecentRuns(1)[0]!;
    expect(queuedRun).toEqual(
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "queued",
        started_at: null,
        finished_at: null,
      }),
    );
    expect(queuedRun.queued_at).toEqual(expect.any(Number));

    const claimedRun = db.claimNextQueuedRun();
    expect(claimedRun).toEqual(
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "ingesting",
        queued_at: queuedRun.queued_at,
        details_json: JSON.stringify({ requestId: "abc" }),
      }),
    );
    expect(claimedRun?.started_at).toEqual(expect.any(Number));
    expect(claimedRun?.started_at).toBeGreaterThanOrEqual(claimedRun?.queued_at ?? 0);

    db.finishRun(runId, { projected: 3 });
    expect(db.listRecentRuns(1)[0]).toEqual(
      expect.objectContaining({
        id: runId,
        status: "completed",
        queued_at: queuedRun.queued_at,
        started_at: claimedRun?.started_at,
        finished_at: expect.any(Number),
      }),
    );

    const failedId = db.queueSyncRun({
      platform: "linkedin",
      accountKey: "default",
      runType: "sync",
      trigger: "manual",
    });
    db.failRun(failedId, "boom", { code: "x" });
    expect(db.listRecentRuns(2).some((run) => run.id === failedId && run.status === "failed")).toBe(
      true,
    );
    expect(db.getLatestSyncRunError("linkedin", "default")).toEqual({
      sync_run_id: failedId,
      error_message: "boom",
      created_at: expect.any(Number),
      details_json: JSON.stringify({ code: "x" }),
    });

    db.close();
  });

  it("migrates legacy sync run timing into queued and started timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-db-legacy-sync-runs-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "local.db");
    const sqlite = new Database(dbPath);

    sqlite.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        account_key TEXT,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        details_json TEXT
      );

      CREATE TABLE sync_run_errors (
        id TEXT PRIMARY KEY,
        sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
        platform TEXT,
        account_key TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    const appliedAt = 1_700_000_000_000;
    for (const migration of MIGRATIONS.slice(0, -1)) {
      sqlite
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, appliedAt);
    }

    sqlite
      .prepare(
        `
          INSERT INTO sync_runs (
            id, platform, account_key, run_type, status, trigger, started_at, finished_at, details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "queued-run",
        "signal",
        "default",
        "sync",
        "queued",
        "manual",
        100,
        null,
        '{"source":"signal"}',
      );
    sqlite
      .prepare(
        `
          INSERT INTO sync_runs (
            id, platform, account_key, run_type, status, trigger, started_at, finished_at, details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "completed-run",
        "whatsapp",
        "default",
        "sync",
        "completed",
        "manual",
        200,
        250,
        '{"source":"whatsapp"}',
      );
    sqlite
      .prepare(
        `
          INSERT INTO sync_run_errors (
            id, sync_run_id, platform, account_key, error_code, error_message, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("error-1", "completed-run", "whatsapp", "default", "E_SYNC", "boom", "{}", 260);
    sqlite.close();

    const db = new CuedDatabase(dbPath);
    db.migrate();

    const migratedSqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            all: () => Array<Record<string, unknown>>;
          };
        };
      }
    ).sqlite;
    const migratedRuns = migratedSqlite
      .prepare(
        `
          SELECT id, status, queued_at, started_at, finished_at
          FROM sync_runs
          ORDER BY id ASC
        `,
      )
      .all() as Array<{
      id: string;
      status: string;
      queued_at: number;
      started_at: number | null;
      finished_at: number | null;
    }>;
    const migratedErrors = migratedSqlite
      .prepare("SELECT id, sync_run_id FROM sync_run_errors ORDER BY id ASC")
      .all() as Array<{ id: string; sync_run_id: string }>;

    expect(migratedRuns).toEqual([
      {
        id: "completed-run",
        status: "completed",
        queued_at: 200,
        started_at: 200,
        finished_at: 250,
      },
      {
        id: "queued-run",
        status: "queued",
        queued_at: 100,
        started_at: null,
        finished_at: null,
      },
    ]);
    expect(migratedErrors).toEqual([{ id: "error-1", sync_run_id: "completed-run" }]);

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
      last_success_at: 1_700_000_000_500,
      last_error_summary: "none",
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
    db.recordCheckpointError("contacts", "local", "sync failed");
    expect(db.getCheckpoint("contacts", "local")).toEqual({
      source_cursor_json: JSON.stringify({ snapshotAt: 456 }),
      sync_mode: "incremental",
      raw_ingest_watermark: 6,
      projection_watermark: 4,
      last_success_at: 1_700_000_000_500,
      last_error_summary: "sync failed",
    });
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

  it("batches source account and raw event writes without duplicating rows", () => {
    const db = createDb();

    db.upsertSourceAccounts([
      {
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
      },
      {
        platform: "slack",
        accountKey: "default",
        displayName: "Slack Updated",
      },
    ]);

    const insertResult = db.insertRawEvents([
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1" },
      },
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1" },
      },
      {
        id: "event-2",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 101,
        dedupeKey: "event-2",
        payload: { sourceMessageKey: "m2" },
      },
    ]);

    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getIntegrationState("slack", "default")).toBeNull();
    expect(insertResult.insertedCount).toBe(2);
    expect(insertResult.insertedEvents.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(insertResult.firstInsertedRowId).toBe(1);
    expect(insertResult.lastInsertedRowId).toBe(2);
    expect(db.listRawEvents().map((event) => event.id)).toEqual(["event-1", "event-2"]);

    db.close();
  });

  it("counts only dedupe-inserted raw events in batched writes", () => {
    const db = createDb();

    const duplicateDedupeKey = `contacts:duplicate:${randomUUID()}`;
    const result = db.insertRawEvents([
      {
        id: randomUUID(),
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: duplicateDedupeKey,
        payload: {
          sourceEntityKey: "contacts:one",
          fields: { display_name: "One" },
          handles: [{ type: "phone", value: "+15551234567", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      },
      {
        id: randomUUID(),
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 2,
        dedupeKey: duplicateDedupeKey,
        payload: {
          sourceEntityKey: "contacts:one",
          fields: { display_name: "One" },
          handles: [{ type: "phone", value: "+15551234567", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      },
    ]);

    expect(result.insertedCount).toBe(1);
    expect(result.insertedEvents).toHaveLength(1);
    expect(db.getOverview().rawEvents).toBe(1);

    db.close();
  });
});
