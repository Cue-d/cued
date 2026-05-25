import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase, openExistingCuedDatabase } from "./database.js";

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

  it("counts observed phone calls with a targeted raw event query", () => {
    const db = createDb();

    db.insertRawEvents([
      {
        id: randomUUID(),
        platform: "imessage",
        accountKey: "local",
        entityKind: "call",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "imessage:call:1",
        payload: {
          sourceCallKey: "call-1",
          sourceConversationKey: "conversation-1",
          provider: "facetime",
          direction: "incoming",
          medium: "audio",
          status: "missed",
          startedAt: 1,
        },
      },
    ]);
    db.insertRawEvents([
      {
        id: randomUUID(),
        platform: "slack",
        accountKey: "workspace",
        entityKind: "message",
        eventKind: "created",
        observedAt: 2,
        dedupeKey: "slack:message:1",
        payload: {
          sourceMessageKey: "message-1",
          sourceConversationKey: "channel-1",
          sender: { sourceContactKey: "user-1", displayName: "Ava" },
          sentAt: 2,
          text: "Not a call",
        },
      },
    ]);

    expect(db.countObservedPhoneCalls()).toBe(1);

    db.close();
  });

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
      messageBreakdown: [],
    });
    db.close();
  });

  it("queues message FTS indexing work independently", () => {
    const db = createDb();

    expect(db.enqueueMessageFtsIndex(["message-a", "message-b", "message-a"])).toBe(2);
    expect(db.enqueueMessageFtsIndex(["message-a"])).toBe(1);

    expect(db.getMessageFtsIndexBacklog()).toEqual({
      queued: 2,
      indexing: 0,
      failed: 0,
      pending: 2,
    });
    expect(
      sqlite(db)
        .prepare("SELECT message_id, status FROM message_fts_index_queue ORDER BY message_id")
        .all(),
    ).toEqual([
      { message_id: "message-a", status: "queued" },
      { message_id: "message-b", status: "queued" },
    ]);

    db.close();
  });

  it("drains queued message FTS indexing work in bounded batches", () => {
    const db = createDb();
    const timestamp = Date.now();
    sqlite(db)
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, type,
          is_active, name, participant_names, created_at, updated_at
        ) VALUES (
          'conversation-a', 'slack', 'team-a', 'channel-a', 'group',
          1, 'Launch', 'Theo | Soham', ?, ?
        )
      `,
      )
      .run(timestamp, timestamp);
    sqlite(db)
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id,
          sender_contact_id, sender_source_key, sender_name, conversation_name, sent_at,
          status, is_from_me, content, delivered_at, read_at,
          is_deleted, created_at, updated_at
        ) VALUES (
          'message-a', 'slack', 'team-a', 'ts-a', 'conversation-a',
          NULL, NULL, 'Soham', 'Launch', ?, NULL, 0,
          'queued index content', NULL, NULL, 0, ?, ?
        )
      `,
      )
      .run(timestamp, timestamp, timestamp);
    sqlite(db).prepare("DELETE FROM messages_fts").run();

    expect(db.enqueueMessageFtsIndex(["message-a"])).toBe(1);
    expect(db.drainMessageFtsIndexQueue(1)).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(
      sqlite(db)
        .prepare("SELECT message_id, content FROM messages_fts WHERE messages_fts MATCH ?")
        .all("queued"),
    ).toEqual([{ message_id: "message-a", content: "queued index content" }]);
    expect(
      sqlite(db).prepare("SELECT COUNT(*) AS count FROM message_fts_index_queue").get(),
    ).toEqual({ count: 0 });

    db.close();
  });

  it("requeues stale message FTS indexing work", () => {
    const db = createDb();
    const timestamp = Date.now();

    expect(db.enqueueMessageFtsIndex(["message-a", "message-b"])).toBe(2);
    sqlite(db)
      .prepare("UPDATE message_fts_index_queue SET status = 'indexing', updated_at = ?")
      .run(timestamp - 10_000);
    sqlite(db)
      .prepare("UPDATE message_fts_index_queue SET updated_at = ? WHERE message_id = 'message-b'")
      .run(timestamp);

    expect(db.requeueStaleMessageFtsIndexing(timestamp - 5_000)).toBe(1);
    expect(
      sqlite(db)
        .prepare("SELECT message_id, status FROM message_fts_index_queue ORDER BY message_id")
        .all(),
    ).toEqual([
      { message_id: "message-a", status: "queued" },
      { message_id: "message-b", status: "indexing" },
    ]);

    db.close();
  });

  it("executes read-only SQL for ad hoc inspection", () => {
    const db = createDb();

    expect(db.executeReadOnlySql("select 1 as value")).toEqual([{ value: 1 }]);
    expect(() => db.executeReadOnlySql("insert into app_settings (key) values ('nope')")).toThrow(
      "Only read-only SELECT/PRAGMA/EXPLAIN queries are supported",
    );

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

  it("stores current contact memories and marks superseded memories stale", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen" });

    const original = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      evidence: { messageIds: ["message-1"] },
      confidence: 83,
      createdBy: "test",
    });

    expect(original).toMatchObject({
      contact_id: "contact-1",
      contact_name: "Ava Chen",
      body: "Works on applied AI and prefers concise follow-ups.",
      source_kind: "local_messages",
      evidence_json: JSON.stringify({ messageIds: ["message-1"] }),
      confidence: 83,
      stale_at: null,
      created_by: "test",
    });

    const replacement = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers direct, concise messages.",
      sourceKind: "local_messages",
      evidence: { messageIds: ["message-2"], supersedesReason: "more recent evidence" },
      confidence: 91,
      supersedesMemoryId: original.id,
      createdBy: "test",
    });

    expect(replacement.supersedes_memory_id).toBe(original.id);
    expect(
      db
        .listContactMemories({ contactId: "contact-1", includeStale: true })
        .find((row) => row.id === original.id)?.stale_at,
    ).toEqual(expect.any(Number));
    expect(db.listContactMemories({ contactId: "contact-1" }).map((row) => row.id)).toEqual([
      replacement.id,
    ]);
    expect(
      db.listContactMemories({ contactId: "contact-1", includeStale: true }).map((row) => row.id),
    ).toEqual([replacement.id, original.id]);

    db.close();
  });

  it("rejects superseding a memory from a different contact", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen" });
    insertContact(db, { id: "contact-2", name: "Ben Lee" });
    const otherMemory = db.addContactMemory({
      contactId: "contact-2",
      body: "Works on robotics.",
      sourceKind: "local_messages",
    });

    expect(() =>
      db.addContactMemory({
        contactId: "contact-1",
        body: "Works on applied AI.",
        sourceKind: "local_messages",
        supersedesMemoryId: otherMemory.id,
      }),
    ).toThrow("Cannot supersede a contact memory from a different contact.");

    db.close();
  });

  it("preserves contact memories across projected state rebuilds", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 1 });
    const memory = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    sqlite(db).prepare("DELETE FROM contacts").run();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 2 });

    expect(db.listContactMemories({ contactId: "contact-1", includeStale: true })[0]).toMatchObject(
      {
        id: memory.id,
        contact_id: "contact-1",
        contact_name: "Ava Chen",
        body: "Works on applied AI and prefers concise follow-ups.",
      },
    );

    db.close();
  });

  it("can read and stale preserved contact memories when the projected contact is absent", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 1 });
    const memory = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    sqlite(db).prepare("DELETE FROM contacts").run();

    expect(db.listContactMemories({ contactId: "contact-1", includeStale: true })[0]).toMatchObject(
      {
        id: memory.id,
        contact_id: "contact-1",
        contact_name: null,
        body: "Works on applied AI and prefers concise follow-ups.",
        stale_at: null,
      },
    );
    expect(db.listContactMemories({ contactId: "contact-1" }).map((row) => row.id)).toEqual([
      memory.id,
    ]);
    expect(db.markContactMemoryStale(memory.id)).toMatchObject({
      id: memory.id,
      contact_name: null,
      stale_at: expect.any(Number),
    });

    db.close();
  });

  it("persists generic sync scopes and proofs", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "running",
        observedAt: 200,
        resumeCursor: {
          historyCursor: "history-2",
        },
        coverage: {
          oldestMessageTs: "1710000000.000100",
          newestMessageTs: "1710000000.000100",
        },
      },
    });

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "complete",
        observedAt: 300,
        coverage: {
          oldestMessageTs: "1709999999.000000",
          newestMessageTs: "1710000000.000300",
        },
        stats: {
          knownConversationCount: 3,
        },
      },
    });

    expect(db.listSyncProofs("slack", "workspace-a")).toEqual([
      expect.objectContaining({
        scope_kind: "conversation",
        scope_key: "C123",
        proof_kind: "messages",
        status: "complete",
        resume_cursor_json: null,
        coverage_json: JSON.stringify({
          oldestMessageTs: "1709999999.000000",
          newestMessageTs: "1710000000.000300",
        }),
        stats_json: JSON.stringify({
          knownConversationCount: 3,
        }),
      }),
    ]);

    db.close();
  });

  it("uses unambiguous generic sync proof ids for colon-bearing keys", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "a:b",
      proof: {
        scope: {
          kind: "conversation",
          key: "d",
        },
        proofKind: "messages",
        status: "running",
        observedAt: 100,
      },
    });
    db.upsertSyncProof({
      platform: "slack",
      accountKey: "a",
      proof: {
        scope: {
          kind: "conversation",
          key: "c:d",
        },
        proofKind: "messages",
        status: "complete",
        observedAt: 200,
      },
    });

    expect(db.listSyncProofs("slack", "a:b")).toEqual([
      expect.objectContaining({
        scope_kind: "conversation",
        scope_key: "d",
        status: "running",
      }),
    ]);
    expect(db.listSyncProofs("slack", "a")).toEqual([
      expect.objectContaining({
        scope_kind: "conversation",
        scope_key: "c:d",
        status: "complete",
      }),
    ]);

    db.close();
  });

  it("rejects sync proofs without a known proof contract", () => {
    const db = createDb();

    expect(() =>
      db.upsertSyncProof({
        platform: "slack",
        accountKey: "workspace-a",
        proof: {
          scope: {
            kind: "account",
            key: "workspace-a",
          },
          proofKind: "replies",
          status: "running",
          observedAt: 100,
        },
      }),
    ).toThrow("No sync proof contract for slack:account:replies");

    db.close();
  });

  it("updates a generic sync proof when it returns to running", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "complete",
        observedAt: 100,
      },
    });
    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "running",
        observedAt: 200,
      },
    });

    expect(db.listSyncProofs("slack", "workspace-a")).toEqual([
      expect.objectContaining({
        status: "running",
        last_observed_at: 200,
      }),
    ]);

    db.close();
  });

  it("persists app settings and install metadata", () => {
    const db = createDb();

    db.setAppSetting("installed_app_version", "0.1.0-internal.1");
    db.setAppSetting("release_channel", "internal");
    db.setAppSetting("cli_symlink_installed", "1");
    db.markOnboardingCompleted("0.1.0-internal.1");
    db.setUpdateReleaseState({
      checkedAt: 123456789,
      channel: "internal",
      currentVersion: "0.1.0-internal.1",
      latestVersion: null,
      availableVersion: null,
      releaseUrl: null,
      tarballUrl: null,
      etag: null,
    });

    expect(db.getAppMetadata()).toEqual({
      onboardingCompletedVersion: "0.1.0-internal.1",
      releaseChannel: "internal",
      installedAppVersion: "0.1.0-internal.1",
      lastReleaseCheckAt: 123456789,
      cliSymlinkInstalled: true,
      updateReleaseState: {
        checkedAt: 123456789,
        channel: "internal",
        currentVersion: "0.1.0-internal.1",
        latestVersion: null,
        availableVersion: null,
        releaseUrl: null,
        tarballUrl: null,
        etag: null,
      },
      updatePendingRollback: null,
      updateLastError: null,
    });
    expect(db.getAppSetting("installed_app_version")?.value).toBe("0.1.0-internal.1");

    db.close();
  });

  it("opens existing databases without startup metadata writes", () => {
    const db = createDb();
    const dbPath = db.dbPath;
    db.setAppSetting("installed_app_version", "0.1.0");
    db.setAppSetting("release_channel", "stable");
    db.close();

    const existing = openExistingCuedDatabase(dbPath);
    existing.setUpdateLastError(null);
    existing.close();

    const reopened = new CuedDatabase(dbPath);
    expect(reopened.getAppMetadata().installedAppVersion).toBe("0.1.0");
    expect(reopened.getAppMetadata().releaseChannel).toBe("stable");
    reopened.close();

    const missingDir = mkdtempSync(join(tmpdir(), "cued-v2-db-missing-"));
    tempDirs.push(missingDir);
    const missingPath = join(missingDir, "local.db");
    expect(() => openExistingCuedDatabase(missingPath)).toThrow(
      `Cued database does not exist at ${missingPath}`,
    );
    expect(existsSync(missingPath)).toBe(false);
  });

  it("reads projection backlog without initializing projection state", () => {
    const db = createDb();
    const dbPath = db.dbPath;
    db.close();

    const readonly = openExistingCuedDatabase(dbPath, { readonly: true });
    expect(readonly.getProjectionBacklog({ initializeProjectionState: false })).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 0,
      pending_raw_events: 0,
    });
    readonly.close();
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

    expect(db.listEnabledSyncTargets()).toEqual([{ platform: "linkedin", account_key: "default" }]);
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

  it("repairs canonical integration ids when upserting existing platform accounts", () => {
    const db = createDb();
    const timestamp = Date.now();
    sqlite(db)
      .prepare(
        `
        INSERT INTO integration_states (
          id, platform, account_key, display_name, auth_state, enabled, connection_kind,
          sync_capable, launch_strategy, launch_target, imported_from, artifact_paths_json,
          metadata_json, last_seen_at, created_at, updated_at
        ) VALUES (?, 'signal', 'default', 'Signal', 'cancelled', 0, 'local-cli', 0,
          'qr-native', NULL, 'legacy', '[]', '{}', ?, ?, ?)
      `,
      )
      .run("legacy-signal-id", timestamp, timestamp, timestamp);

    const legacySessionId = db.createAuthSession({
      platform: "signal",
      accountKey: "default",
      integrationStateId: "legacy-signal-id",
      state: "cancelled",
    });

    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
      authState: "requested",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: false,
      launchStrategy: "qr-native",
      importedFrom: "bundled-helper",
    });

    expect(db.getIntegrationState("signal", "default")).toEqual(
      expect.objectContaining({
        id: "signal:default",
        auth_state: "requested",
        enabled: 1,
      }),
    );

    expect(db.getAuthSession(legacySessionId)).toEqual(
      expect.objectContaining({
        integration_state_id: "signal:default",
      }),
    );

    const sessionId = db.createAuthSession({
      platform: "signal",
      accountKey: "default",
      integrationStateId: "signal:default",
      state: "requested",
    });
    expect(db.getAuthSession(sessionId)).toEqual(
      expect.objectContaining({
        integration_state_id: "signal:default",
      }),
    );

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
      keychainService: "so.cued.desktop.auth.slack",
      keychainAccount: "workspace-a",
      resultSummary: { teamId: "T123" },
    });

    expect(db.getOverview().authSessions).toBe(1);
    expect(db.getAuthSession(sessionId)).toEqual(
      expect.objectContaining({
        id: sessionId,
        state: "authenticated",
        keychain_service: "so.cued.desktop.auth.slack",
        keychain_account: "workspace-a",
        result_summary_json: JSON.stringify({ teamId: "T123" }),
      }),
    );
    expect(db.getLatestAuthSession("slack", "workspace-a")?.id).toBe(sessionId);

    db.close();
  });

  it("records manual merge decisions and resolves canonical contact chains", () => {
    const db = createDb();

    insertContact(db, { id: "contact-a", name: "Ava Prime" });
    insertContact(db, { id: "contact-b", name: "Ava Duplicate" });
    insertContact(db, { id: "contact-c", name: "Ava Canonical" });

    expect(
      db.recordContactMergeDecision({
        primaryContactId: "contact-a",
        secondaryContactId: "contact-b",
        reason: "same phone",
      }),
    ).toEqual({
      decisionId: expect.any(String),
      primaryContactId: "contact-a",
      secondaryContactId: "contact-b",
      canonicalContactId: "contact-a",
    });

    expect(
      db.recordContactMergeDecision({
        primaryContactId: "contact-c",
        secondaryContactId: "contact-a",
        reason: "prefer contacts source",
      }),
    ).toEqual({
      decisionId: expect.any(String),
      primaryContactId: "contact-c",
      secondaryContactId: "contact-a",
      canonicalContactId: "contact-c",
    });

    expect(() =>
      db.recordContactMergeDecision({
        primaryContactId: "contact-c",
        secondaryContactId: "contact-b",
      }),
    ).toThrow("Contacts already resolve to the same canonical contact: contact-c");
    expect(
      sqlite(db).prepare("SELECT COUNT(*) AS count FROM contact_merge_decisions").get(),
    ).toEqual({ count: 2 });

    db.close();
  });

  it("moves secondary contact memories to the canonical contact on merge", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Prime" });
    insertContact(db, { id: "contact-b", name: "Ava Duplicate" });
    const memory = db.addContactMemory({
      contactId: "contact-b",
      body: "Prefers short follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    db.recordContactMergeDecision({
      primaryContactId: "contact-a",
      secondaryContactId: "contact-b",
      reason: "same email",
    });

    expect(db.listContactMemories({ contactId: "contact-a" }).map((row) => row.id)).toEqual([
      memory.id,
    ]);
    expect(db.listContactMemories({ contactId: "contact-b" })).toEqual([]);

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
        attempt: 1,
        owner_id: null,
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
      error_message: "boom",
      created_at: expect.any(Number),
    });
    expect(
      sqlite(db)
        .prepare("SELECT status, owner_id, lease_expires_at FROM sync_runs WHERE id = ?")
        .get(failedId),
    ).toEqual({
      status: "failed",
      owner_id: null,
      lease_expires_at: null,
    });

    db.close();
  });

  it("reclaims expired sync run leases automatically", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });

    expect(
      db.claimNextQueuedRun(["sync"], "ingesting", {
        ownerId: "daemon-a",
        leaseMs: 10_000,
      }),
    ).toEqual(expect.objectContaining({ id: runId, attempt: 1, owner_id: "daemon-a" }));
    expect(db.claimNextQueuedRun(["sync"], "ingesting")).toBeNull();

    sqlite(db).prepare("UPDATE sync_runs SET lease_expires_at = 1 WHERE id = ?").run(runId);
    expect(
      db.claimNextQueuedRun(["sync"], "ingesting", {
        ownerId: "daemon-b",
        leaseMs: 20_000,
      }),
    ).toEqual(expect.objectContaining({ id: runId, attempt: 2, owner_id: "daemon-b" }));
    expect(
      db.finishRun(runId, undefined, {
        ownerId: "daemon-a",
        attempt: 1,
      }),
    ).toBe(false);
    expect(
      sqlite(db).prepare("SELECT status, owner_id, attempt FROM sync_runs WHERE id = ?").get(runId),
    ).toEqual({ status: "ingesting", owner_id: "daemon-b", attempt: 2 });

    expect(db.finishRun(runId, undefined, { ownerId: "daemon-b", attempt: 2 })).toBe(true);
    expect(
      sqlite(db)
        .prepare("SELECT status, owner_id, lease_expires_at FROM sync_runs WHERE id = ?")
        .get(runId),
    ).toEqual({ status: "completed", owner_id: null, lease_expires_at: null });

    db.close();
  });

  it("reports queued and expired sync runs as future claimable wakeups", () => {
    const db = createDb();
    const timestamp = Date.now();
    const queuedRunId = db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "scheduler",
      scheduledAt: timestamp + 60_000,
    });
    const runningRunId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });
    db.claimNextQueuedRun(["sync"], "ingesting", {
      ownerId: "daemon-a",
      leaseMs: 30_000,
    });
    sqlite(db)
      .prepare("UPDATE sync_runs SET lease_expires_at = ? WHERE id = ?")
      .run(timestamp + 30_000, runningRunId);

    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBe(timestamp + 30_000);
    db.failRun(runningRunId, "forced");
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeGreaterThanOrEqual(timestamp);
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeLessThanOrEqual(timestamp + 60_000);

    db.failRun(queuedRunId, "forced");
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeNull();

    db.close();
  });

  it("recovers in-progress sync runs as queued after daemon restart", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });
    db.claimNextQueuedRun(["sync"], "ingesting", {
      ownerId: "daemon-before-restart",
      leaseMs: 60_000,
    });

    expect(db.recoverInProgressRuns()).toBe(1);
    expect(
      sqlite(db)
        .prepare(
          `
          SELECT status, owner_id, lease_expires_at
          FROM sync_runs
          WHERE id = ?
        `,
        )
        .get(runId),
    ).toEqual({
      status: "queued",
      owner_id: null,
      lease_expires_at: null,
    });
    expect(db.claimNextQueuedRun(["sync"], "ingesting")).toEqual(
      expect.objectContaining({ id: runId, attempt: 2 }),
    );

    db.close();
  });

  it("does not claim queued sync runs before their scheduled time", () => {
    const db = createDb();
    const futureRunId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync_resume",
      trigger: "ingest_continue",
      delayMs: 60_000,
    });

    expect(db.claimNextQueuedRun(["sync_resume"])).toBeNull();
    const nextScheduledAt = db.getNextQueuedRunScheduledAt(["sync_resume"]);
    expect(nextScheduledAt).toBeGreaterThan(Date.now());

    db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "manual",
    });

    expect(db.claimNextQueuedRun(["sync"])?.platform).toBe("contacts");
    expect(db.listRecentRuns(5).find((run) => run.id === futureRunId)?.status).toBe("queued");

    db.close();
  });

  it("reschedules queued sync runs", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      runType: "project",
      trigger: "projection_continue",
      delayMs: 60_000,
    });

    expect(db.claimNextQueuedRun(["project"])).toBeNull();

    db.rescheduleRun(runId, Date.now() - 1);
    expect(db.claimNextQueuedRun(["project"])?.id).toBe(runId);

    db.close();
  });

  it("stores checkpoints and raw events", () => {
    const db = createDb();

    db.upsertSourceAccounts([
      {
        platform: "contacts",
        accountKey: "local",
        displayName: "macOS Contacts",
      },
    ]);
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
    db.insertRawEvents([
      {
        id: rawEventId,
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_700_000_000_000,
        dedupeKey: "contacts:1",
        payload: {
          sourceEntityKey: "contacts:1",
          fields: { display_name: "Ava" },
          handles: [],
        },
      },
    ]);

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
    expect(db.listCheckpointTargets()).toEqual([{ platform: "contacts", account_key: "local" }]);
    expect(
      sqlite(db)
        .prepare(
          `
          SELECT id, platform, account_key, entity_kind, event_kind, normalized_schema, observed_at, payload_json
          FROM raw_events
          ORDER BY observed_at, id
        `,
        )
        .all(),
    ).toEqual([
      {
        id: rawEventId,
        platform: "contacts",
        account_key: "local",
        entity_kind: "contact",
        event_kind: "observed",
        normalized_schema: "contact.observed@1",
        observed_at: 1_700_000_000_000,
        payload_json: JSON.stringify({
          sourceEntityKey: "contacts:1",
          fields: { display_name: "Ava" },
          handles: [],
        }),
      },
    ]);

    expect(db.getProjectionState()).toEqual({
      singleton_key: "global",
      projection_watermark: 0,
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
    sql.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_contact_id TEXT,
        sender_source_key TEXT,
        sender_name TEXT,
        conversation_name TEXT,
        sent_at INTEGER NOT NULL,
        status TEXT,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        delivered_at INTEGER,
        read_at INTEGER,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, platform_message_id)
      )
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
        access_kind TEXT,
        access_ref_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_attachment_key)
      )
    `);
    sql.exec(`
      CREATE TABLE message_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_reaction_key TEXT NOT NULL,
        reactor_source_key TEXT,
        emoji TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_reaction_key)
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
    const messageReactionColumns = (
      sql.prepare("PRAGMA table_info(message_reactions)").all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(rawEventColumns).toEqual(expect.arrayContaining(["normalized_schema"]));
    expect(rawEventColumns).not.toEqual(
      expect.arrayContaining([
        "external_event_id",
        "cursor_json",
        "source_version",
        "provenance_json",
      ]),
    );
    expect(conversationColumns).toContain("is_active");
    expect(conversationColumns).not.toEqual(
      expect.arrayContaining([
        "native_conversation_key",
        "topic",
        "removal_reason",
        "service",
        "last_message_id",
        "last_message_at",
        "last_message_preview",
        "unread_count",
      ]),
    );
    expect(timelineColumns).toContain("subject_source_key");
    expect(timelineColumns).toContain("system_kind");
    expect(timelineColumns).toContain("call_provider");
    expect(timelineColumns).toContain("call_direction");
    expect(messageReactionColumns).not.toContain("source_reaction_key");
    expect(
      sql.prepare("SELECT is_active FROM conversations WHERE id = ?").get("legacy-conversation"),
    ).toEqual({ is_active: 0 });

    db.close();
  });

  it("records the legacy removal_reason repair without keeping the removed column", () => {
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

    expect(conversationColumns).not.toEqual(expect.arrayContaining(["removal_reason", "service"]));
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
    const synchronousProjectionTriggerRows = sql
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN (
            'trg_messages_inserted_fts',
            'trg_messages_updated_fts',
            'trg_messages_deleted_fts',
            'trg_message_attachments_inserted',
            'trg_message_attachments_updated',
            'trg_message_attachments_deleted',
            'trg_message_reactions_inserted',
            'trg_message_reactions_updated',
            'trg_message_reactions_deleted',
            'trg_contacts_name_updated',
            'trg_conversations_name_updated',
            'trg_conversation_participants_inserted',
            'trg_conversation_participants_updated',
            'trg_conversation_participants_deleted'
          )
      `,
      )
      .all() as Array<{ name: string }>;

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
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0007_add_generic_sync_proof_tables"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0008_migrate_slack_backfill_proofs_to_generic"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0009_add_contact_fanout_projection_indexes"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0010_add_timeline_call_fields"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0016_drop_synchronous_message_fts_triggers"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0017_drop_remaining_projection_side_effect_triggers"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0018_add_projection_hot_path_indexes"),
    ).toBeTruthy();
    const indexNames = (
      sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "idx_conversation_participants_contact",
        "idx_conversation_participants_conversation_active_self",
        "idx_conversation_participants_conversation_contact_active_updated",
        "idx_conversation_participants_source_key_lower",
        "idx_timeline_events_actor_contact",
        "idx_timeline_events_conversation_latest_system",
        "idx_messages_conversation_latest",
        "idx_messages_conversation_unread",
        "idx_messages_sender_source_key_lower",
      ]),
    );
    expect(syncRunColumns).toEqual(expect.arrayContaining(["queued_at", "scheduled_at"]));
    expect(
      sql
        .prepare("SELECT queued_at, scheduled_at, started_at FROM sync_runs WHERE id = ?")
        .get("legacy-run"),
    ).toEqual({ queued_at: 123, scheduled_at: 123, started_at: null });
    expect(syncRunColumns).toEqual(
      expect.arrayContaining(["attempt", "owner_id", "lease_expires_at"]),
    );
    expect(syncRunColumns).not.toEqual(expect.arrayContaining(["last_progress_at", "error_code"]));
    expect(messageAttachmentColumns).toEqual(
      expect.arrayContaining(["access_kind", "access_ref_json"]),
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        "sync_proofs",
        "message_fts_index_queue",
        "attachment_cache",
        "attachment_content",
        "projection_state",
        "messages_fts",
      ]),
    );
    expect(synchronousProjectionTriggerRows).toEqual([]);

    db.close();
  });

  it("honors the pre-renumbered Discord fanout index migration id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-discord-fanout-legacy-id-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("0008_add_contact_fanout_projection_indexes", 1);

    db.migrate();

    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0008_add_contact_fanout_projection_indexes"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0009_add_contact_fanout_projection_indexes"),
    ).toBeUndefined();

    db.close();
  });

  it("adds contact memories to existing migrated databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-contact-memories-migration-"));
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
      VALUES
        ('0001_bootstrap_current_schema', 1),
        ('0002_upgrade_existing_schema_columns', 2),
        ('0003_repair_conversation_removal_reason', 3),
        ('0004_repair_partial_legacy_bootstrap', 4),
        ('0005_add_contact_merge_decisions', 5),
        ('0006_rename_contact_merge_columns', 6),
        ('0007_add_generic_sync_proof_tables', 7),
        ('0008_migrate_slack_backfill_proofs_to_generic', 8),
        ('0009_add_contact_fanout_projection_indexes', 9),
        ('0010_add_timeline_call_fields', 10),
        ('0011_remove_telegram_runtime_state', 11)
    `);
    sql.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        name TEXT,
        photo_url TEXT,
        company TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.migrate();

    const memoryColumns = (
      sql.prepare("PRAGMA table_info(contact_memories)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);

    expect(memoryColumns).toEqual(
      expect.arrayContaining([
        "contact_id",
        "body",
        "source_kind",
        "evidence_json",
        "confidence",
        "supersedes_memory_id",
        "stale_at",
        "created_at",
      ]),
    );
    expect(
      sql.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get("0012_contact_memories"),
    ).toBeTruthy();
    const contactForeignKeys = (
      sql.prepare("PRAGMA foreign_key_list(contact_memories)").all() as Array<{ table: string }>
    ).filter((foreignKey) => foreignKey.table === "contacts");
    expect(contactForeignKeys).toEqual([]);

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
        payload: { sourceMessageKey: "m1", sourceConversationKey: "c1" },
      },
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1", sourceConversationKey: "c1" },
      },
      {
        id: "event-2",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 101,
        dedupeKey: "event-2",
        payload: { sourceMessageKey: "m2", sourceConversationKey: "c1" },
      },
    ]);

    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getIntegrationState("slack", "default")).toBeNull();
    expect(insertResult.insertedCount).toBe(2);
    expect(insertResult.insertedEvents.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(insertResult.firstInsertedRowId).toBe(1);
    expect(insertResult.lastInsertedRowId).toBe(2);
    expect(
      sqlite(db)
        .prepare("SELECT id, normalized_schema FROM raw_events ORDER BY observed_at, id")
        .all(),
    ).toEqual([
      { id: "event-1", normalized_schema: "message.created@1" },
      { id: "event-2", normalized_schema: "message.created@1" },
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
      },
    ]);

    expect(result.insertedCount).toBe(1);
    expect(result.insertedEvents).toHaveLength(1);
    expect(db.getOverview().rawEvents).toBe(1);

    db.close();
  });

  it("resets platform raw state without rebuilding projections inline", () => {
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
    sqlite(db)
      .prepare(
        `
        UPDATE projection_state
        SET projection_watermark = ?, updated_at = ?
        WHERE singleton_key = 'global'
      `,
      )
      .run(2, timestamp);

    expect(db.getOverview().contacts).toBe(1);
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 2,
      max_raw_event_rowid: 2,
      pending_raw_events: 0,
    });

    const removed = db.resetSource("linkedin");

    expect(removed).toBe(2);
    expect(db.getOverview().contacts).toBe(1);
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
      pending_raw_events: 2,
    });

    db.close();
  });
});
