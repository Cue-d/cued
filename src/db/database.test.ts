import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "./database.js";

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

  function sqlite(db: CuedDatabase) {
    return (
      db as unknown as {
        sqlite: {
          exec: (sql: string) => void;
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
            get: (...params: unknown[]) => unknown;
            all: (...params: unknown[]) => unknown[];
          };
        };
      }
    ).sqlite;
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

  it("stores daemon state", () => {
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

    db.close();
  });

  it("persists slack backfill proofs and completion markers", () => {
    const db = createDb();

    db.upsertSlackBackfillProof({
      accountKey: "workspace-a",
      teamId: "T123",
      conversationId: "C123",
      conversationName: "eng",
      conversationFamily: "channels",
      syncMode: "full",
      scanStartedAt: 100,
      knownConversationCount: 1,
      conversationPhase: "history",
      historyComplete: false,
      historyCursor: "history-2",
      threadRootCount: 1,
      completedThreadCount: 0,
      pendingThreadCount: 1,
      activeThreadTs: null,
      repliesCursor: null,
      oldestMessageTs: "1710000000.000100",
      newestMessageTs: "1710000000.000100",
      observedAt: 200,
    });

    db.upsertSlackBackfillProof({
      accountKey: "workspace-a",
      teamId: "T123",
      conversationId: "C123",
      conversationName: "eng",
      conversationFamily: "channels",
      syncMode: "full",
      scanStartedAt: 100,
      knownConversationCount: 3,
      conversationPhase: "complete",
      historyComplete: true,
      historyCursor: null,
      threadRootCount: 1,
      completedThreadCount: 1,
      pendingThreadCount: 0,
      activeThreadTs: null,
      repliesCursor: null,
      oldestMessageTs: "1709999999.000000",
      newestMessageTs: "1710000000.000300",
      observedAt: 300,
    });

    expect(db.listSlackBackfillProofs("workspace-a")).toEqual([
      expect.objectContaining({
        account_key: "workspace-a",
        conversation_id: "C123",
        conversation_phase: "complete",
        history_complete: 1,
        known_conversation_count: 3,
        thread_root_count: 1,
        completed_thread_count: 1,
        oldest_message_ts: "1709999999.000000",
        newest_message_ts: "1710000000.000300",
        first_discovered_at: 200,
        history_complete_at: 300,
        replies_complete_at: 300,
      }),
    ]);

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

  it("stores messages automation verification state", () => {
    const db = createDb();

    db.setMessagesAutomationVerification({
      status: "granted",
      checkedAt: 123,
      verifiedAt: 123,
      summary: "Apple Events automation access for Messages is available",
    });

    expect(db.getMessagesAutomationVerification()).toEqual({
      status: "granted",
      checkedAt: 123,
      verifiedAt: 123,
      summary: "Apple Events automation access for Messages is available",
    });

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
      normalizedValue: "2016824050",
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

  it("formats local Signal phone sends as E.164 passthrough", () => {
    const db = createDb();

    expect(db.resolveSignalSendTarget("4155550123")).toEqual({
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
      normalizedValue: "2016824050",
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

  it("formats local WhatsApp phone sends as JIDs", () => {
    const db = createDb();

    expect(db.resolveWhatsAppSendTarget("4155550123")).toEqual({
      target: "14155550123@s.whatsapp.net",
      threadId: "dm:14155550123@s.whatsapp.net",
      resolution: "passthrough",
      matchedContactIds: [],
      matchedName: null,
    });

    db.close();
  });

  it("resolves Discord send targets only for DMs", () => {
    const db = createDb();
    const sql = sqlite(db);
    const timestamp = Date.now();

    sql
      .prepare(
        `
      INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          removal_reason, name, topic, participant_names, last_message_id, last_message_at,
          last_message_preview, unread_count, created_at, updated_at
        ) VALUES (?, 'discord', 'default', ?, ?, ?, 1, NULL, ?, NULL, '[]', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("discord-dm", "discord:channel:dm-1", "dm-1", "dm", "Jarvis", timestamp, timestamp);
    sql
      .prepare(
        `
      INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          removal_reason, name, topic, participant_names, last_message_id, last_message_at,
          last_message_preview, unread_count, created_at, updated_at
        ) VALUES (?, 'discord', 'default', ?, ?, ?, 1, NULL, ?, NULL, '[]', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run(
        "discord-channel",
        "discord:channel:guild-1",
        "guild-1",
        "channel",
        "general",
        timestamp,
        timestamp,
      );

    expect(db.resolveDiscordSendTarget("Jarvis")).toEqual({
      target: "dm-1",
      threadId: "discord:channel:dm-1",
      resolution: "conversation_name",
      matchedConversationId: "discord-dm",
      matchedName: "Jarvis",
    });
    expect(db.resolveDiscordSendTarget("general")).toBeNull();
    expect(db.resolveDiscordSendTarget("guild-1")).toBeNull();

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
      lastSuccessAt: 1_700_000_000_000,
    });
    db.upsertCheckpoint({
      platform: "contacts",
      accountKey: "local",
      syncMode: "incremental",
      sourceCursor: { snapshotAt: 456 },
      rawIngestWatermark: 6,
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
      last_success_at: 1_700_000_000_500,
      last_error_summary: "none",
    });
    expect(db.getCheckpoint("contacts", "local")).not.toHaveProperty("projection_watermark");
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
        normalized_schema: "contact.observed@1",
        provenance_json: null,
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
    expect(
      sqlite(db)
        .prepare("SELECT COUNT(*) AS count FROM projection_state WHERE singleton_key = 'global'")
        .get(),
    ).toEqual({ count: 1 });

    db.close();
  });

  it("stores source version separately from provenance metadata", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "raw-event-source-version",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 1_710_000_000_000,
      dedupeKey: "linkedin:source-version",
      payload: {
        sourceMessageKey: "msg-source-version",
        sourceConversationKey: "thread-source-version",
        senderSourceKey: "linkedin:member:ava",
        sentAt: 1_710_000_000_000,
        content: "hello",
      },
      sourceVersion: "linkedin-v7",
      provenance: {
        acquisitionMode: "realtime",
        providerApiVersion: "2026-03",
        adapterVersion: "linkedin-adapter@7",
      },
    });

    const row = sqlite(db)
      .prepare(
        `
          SELECT source_version, provenance_json
          FROM raw_events
          WHERE id = ?
        `,
      )
      .get("raw-event-source-version") as {
      source_version: string | null;
      provenance_json: string | null;
    };

    expect(row).toEqual({
      source_version: "linkedin-v7",
      provenance_json: JSON.stringify({
        providerApiVersion: "2026-03",
        adapterVersion: "linkedin-adapter@7",
        acquisitionMode: "realtime",
      }),
    });

    db.close();
  });

  it("upgrades existing databases with refactor columns and lifecycle state", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-upgrade-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      `INSERT INTO schema_migrations (id, applied_at) VALUES ('0014_messages_fts_rowid_alignment', 1)`,
    );
    sql.exec(`
      CREATE TABLE raw_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        external_event_id TEXT,
        external_entity_id TEXT,
        conversation_external_id TEXT,
        occurred_at INTEGER,
        observed_at INTEGER NOT NULL,
        cursor_json TEXT,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_version TEXT,
        UNIQUE(platform, account_key, dedupe_key)
      )
    `);
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        native_conversation_key TEXT,
        type TEXT NOT NULL,
        subtype TEXT,
        service TEXT,
        name TEXT,
        topic TEXT,
        participant_names TEXT,
        last_message_id TEXT,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_conversation_key)
      )
    `);
    sql.exec(`
      CREATE TABLE timeline_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        actor_contact_id TEXT,
        actor_source_key TEXT,
        actor_name TEXT,
        subject_contact_id TEXT,
        event_at INTEGER NOT NULL,
        text TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_event_key)
      )
    `);
    sql
      .prepare(`
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'linkedin', 'default', ?, NULL, 'dm', 'deleted', 'linkedin', 'Thread', NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `)
      .run("legacy-conversation", "thread-1", 1, 1);

    db.migrate();

    const rawEventColumns = (
      sql.prepare("PRAGMA table_info(raw_events)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const conversationColumns = (
      sql.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const timelineColumns = (
      sql.prepare("PRAGMA table_info(timeline_events)").all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(rawEventColumns).toEqual(
      expect.arrayContaining(["normalized_schema", "provenance_json"]),
    );
    expect(conversationColumns).toContain("is_active");
    expect(conversationColumns).toContain("removal_reason");
    expect(timelineColumns).toContain("subject_source_key");
    expect(
      sql
        .prepare("SELECT is_active, removal_reason FROM conversations WHERE id = ?")
        .get("legacy-conversation"),
    ).toEqual({ is_active: 0, removal_reason: "deleted" });

    db.close();
  });

  it("repairs removal_reason for databases that already marked 0002 applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-removal-reason-repair-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('0001_bootstrap_current_schema', 1), ('0002_upgrade_existing_schema_columns', 2)
    `);
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        native_conversation_key TEXT,
        type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        service TEXT,
        name TEXT,
        topic TEXT,
        participant_names TEXT,
        last_message_id TEXT,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_conversation_key)
      )
    `);

    db.migrate();

    const conversationColumns = (
      sql.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(conversationColumns).toContain("removal_reason");
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0003_repair_conversation_removal_reason"),
    ).toBeTruthy();

    db.close();
  });

  it("repairs partially migrated legacy databases after the squash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-partial-legacy-repair-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('0010_requestable_sync_capable_backfill', 1)
    `);
    sql.exec(`
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        account_key TEXT,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        details_json TEXT
      )
    `);
    sql.exec(`
      CREATE TABLE sync_run_errors (
        id TEXT PRIMARY KEY,
        sync_run_id TEXT NOT NULL,
        platform TEXT,
        account_key TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO sync_runs (
        id, platform, account_key, run_type, status, trigger, started_at, finished_at, details_json
      ) VALUES ('legacy-run', 'slack', 'default', 'sync', 'queued', 'scheduler', 123, NULL, '{}')
    `);
    sql.exec(`
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_attachment_key TEXT NOT NULL,
        kind TEXT,
        mime_type TEXT,
        filename TEXT,
        title TEXT,
        local_path TEXT,
        remote_url TEXT,
        size_bytes INTEGER,
        text_content TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_attachment_key)
      )
    `);

    db.migrate();

    const syncRunColumns = (
      sql.prepare("PRAGMA table_info(sync_runs)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const messageAttachmentColumns = (
      sql.prepare("PRAGMA table_info(message_attachments)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const tables = (
      sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    const triggerSql = sql
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_messages_inserted_fts'",
      )
      .get() as { sql: string } | undefined;

    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0001_bootstrap_current_schema"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0004_repair_partial_legacy_bootstrap"),
    ).toBeTruthy();
    expect(syncRunColumns).toContain("queued_at");
    expect(
      sql.prepare("SELECT queued_at, started_at FROM sync_runs WHERE id = ?").get("legacy-run"),
    ).toEqual({ queued_at: 123, started_at: null });
    expect(messageAttachmentColumns).toEqual(
      expect.arrayContaining([
        "access_kind",
        "access_ref_json",
        "preview_ref_json",
        "availability_status",
        "provider_metadata_json",
      ]),
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        "slack_backfill_proofs",
        "attachment_cache",
        "attachment_content",
        "projection_state",
        "messages_fts",
      ]),
    );
    expect(triggerSql?.sql).toContain("rowid = NEW.rowid");

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
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1" },
      },
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1" },
      },
      {
        id: "event-2",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
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
    expect(db.listRawEvents().map((event) => event.normalized_schema)).toEqual([
      "message.created@1",
      "message.created@1",
    ]);

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

  it("resets platform data and rewinds projection for rebuild", () => {
    const db = createDb();
    const timestamp = Date.now();

    db.upsertSourceAccounts([
      { platform: "linkedin", accountKey: "default", displayName: "LinkedIn" },
      { platform: "slack", accountKey: "default", displayName: "Slack" },
    ]);

    db.insertRawEvents([
      {
        id: "linkedin-reset-raw",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: timestamp,
        dedupeKey: "linkedin-reset-raw",
        payload: { sourceMessageKey: "linkedin:m1", sourceConversationKey: "linkedin:c1" },
      },
      {
        id: "slack-reset-raw",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: timestamp + 1,
        dedupeKey: "slack-reset-raw",
        payload: { sourceMessageKey: "slack:m1", sourceConversationKey: "slack:c1" },
      },
    ]);

    insertContact(db, { id: "contact-reset-1", name: "Reset Contact", updatedAt: timestamp });
    db.upsertProjectionState({
      projectionWatermark: 2,
      lastProjectedAt: timestamp,
      lastRebuildAt: timestamp,
    });

    expect(db.getOverview().contacts).toBe(1);
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 2,
      max_raw_event_rowid: 2,
      pending_raw_events: 0,
    });

    const removed = db.resetSource("linkedin");

    expect(removed).toBe(2);
    expect(db.getOverview().contacts).toBe(0);
    expect(db.getOverview().rawEvents).toBe(1);
    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getCheckpoint("linkedin", "default")).toBeNull();
    expect(
      sqlite(db)
        .prepare("SELECT count(*) AS count FROM raw_events WHERE platform = 'linkedin'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite(db).prepare("SELECT count(*) AS count FROM raw_events WHERE platform = 'slack'").get(),
    ).toEqual({ count: 1 });
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 2,
      pending_raw_events: 1,
    });

    db.close();
  });

  it("removes cached attachment files when clearing projected state", () => {
    const db = createDb();
    const timestamp = Date.now();
    const cacheDir = mkdtempSync(join(tmpdir(), "cued-attachment-cache-"));
    tempDirs.push(cacheDir);
    const cachePath = join(cacheDir, "cached.txt");
    writeFileSync(cachePath, "cached attachment payload");

    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', 1, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-cache-1", "source-conversation-cache-1", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run(
        "message-cache-1",
        "platform-message-cache-1",
        "conversation-cache-1",
        timestamp,
        timestamp,
        timestamp,
      );
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'cached.txt', 'Cached', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-cache-1",
        "message-cache-1",
        "source-attachment-cache-1",
        cachePath,
        25,
        JSON.stringify({ path: cachePath }),
        timestamp,
        timestamp,
      );
    db.upsertAttachmentCacheEntry({
      attachmentId: "attachment-cache-1",
      variant: "original",
      status: "ready",
      cachePath,
      mimeType: "text/plain",
      sizeBytes: 25,
      sha256: "abc123",
      fetchedAt: timestamp,
      lastAccessedAt: timestamp,
    });

    db.clearProjectedState();

    expect(existsSync(cachePath)).toBe(false);
    expect(db.getAttachmentCacheEntry("attachment-cache-1", "original")).toBeNull();

    db.close();
  });
});
