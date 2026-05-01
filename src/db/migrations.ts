import type Database from "better-sqlite3-multiple-ciphers";

type MigrationDatabase = InstanceType<typeof Database>;

export type Migration = {
  id: string;
  legacyIds?: string[];
  sql?: string;
  apply?: (db: MigrationDatabase) => void;
};

function tableExists(db: MigrationDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

function columnExists(db: MigrationDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(db: MigrationDatabase, tableName: string, definition: string): void {
  const [columnName] = definition.trim().split(/\s+/, 1);
  if (!columnName || columnExists(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function buildSyncScopeId(
  platform: string,
  accountKey: string,
  scopeKind: string,
  scopeKey: string,
): string {
  return `scope:${Buffer.from(JSON.stringify([platform, accountKey, scopeKind, scopeKey])).toString(
    "base64url",
  )}`;
}

function buildSyncProofId(
  platform: string,
  accountKey: string,
  scopeKind: string,
  scopeKey: string,
  proofKind: string,
): string {
  return `proof:${Buffer.from(
    JSON.stringify([platform, accountKey, scopeKind, scopeKey, proofKind]),
  ).toString("base64url")}`;
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function migrateSlackBackfillProofsToGeneric(db: MigrationDatabase): void {
  if (
    !tableExists(db, "slack_backfill_proofs") ||
    !tableExists(db, "sync_scopes") ||
    !tableExists(db, "sync_proofs")
  ) {
    return;
  }

  const rows = db.prepare("SELECT * FROM slack_backfill_proofs").all() as Array<{
    account_key: string;
    team_id: string;
    conversation_id: string;
    conversation_name: string | null;
    conversation_family: string;
    sync_mode: string;
    scan_started_at: number;
    known_conversation_count: number;
    conversation_phase: string;
    history_complete: number;
    history_cursor: string | null;
    thread_root_count: number;
    completed_thread_count: number;
    pending_thread_count: number;
    active_thread_ts: string | null;
    replies_cursor: string | null;
    oldest_message_ts: string | null;
    newest_message_ts: string | null;
    first_discovered_at: number;
    history_complete_at: number | null;
    replies_complete_at: number | null;
    last_observed_at: number;
    updated_at: number;
  }>;
  if (rows.length === 0) {
    return;
  }

  const upsertScope = db.prepare(`
    INSERT INTO sync_scopes (
      id,
      platform,
      account_key,
      scope_kind,
      scope_key,
      parent_scope_id,
      display_name,
      metadata_json,
      first_discovered_at,
      last_observed_at,
      created_at,
      updated_at
    ) VALUES (?, 'slack', ?, 'conversation', ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, account_key, scope_kind, scope_key) DO UPDATE SET
      display_name = excluded.display_name,
      metadata_json = excluded.metadata_json,
      first_discovered_at = MIN(sync_scopes.first_discovered_at, excluded.first_discovered_at),
      last_observed_at = MAX(sync_scopes.last_observed_at, excluded.last_observed_at),
      updated_at = MAX(sync_scopes.updated_at, excluded.updated_at)
  `);
  const upsertProof = db.prepare(`
    INSERT INTO sync_proofs (
      id,
      platform,
      account_key,
      scope_id,
      proof_kind,
      status,
      sync_mode,
      run_started_at,
      last_observed_at,
      completed_at,
      fresh_until,
      resume_cursor_json,
      coverage_json,
      stats_json,
      error_json,
      created_at,
      updated_at
    ) VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(platform, account_key, scope_id, proof_kind) DO UPDATE SET
      status = excluded.status,
      sync_mode = excluded.sync_mode,
      run_started_at = excluded.run_started_at,
      last_observed_at = MAX(sync_proofs.last_observed_at, excluded.last_observed_at),
      completed_at = COALESCE(sync_proofs.completed_at, excluded.completed_at),
      resume_cursor_json = excluded.resume_cursor_json,
      coverage_json = excluded.coverage_json,
      stats_json = excluded.stats_json,
      updated_at = MAX(sync_proofs.updated_at, excluded.updated_at)
  `);

  for (const row of rows) {
    const scopeId = buildSyncScopeId("slack", row.account_key, "conversation", row.conversation_id);
    const firstDiscoveredAt = row.first_discovered_at ?? row.last_observed_at;
    const updatedAt = row.updated_at ?? row.last_observed_at;
    upsertScope.run(
      scopeId,
      row.account_key,
      row.conversation_id,
      row.conversation_name,
      stringifyJson({
        teamId: row.team_id,
        conversationFamily: row.conversation_family,
      }),
      firstDiscoveredAt,
      row.last_observed_at,
      firstDiscoveredAt,
      updatedAt,
    );

    const messagesComplete = row.history_complete === 1 || row.conversation_phase !== "history";
    upsertProof.run(
      buildSyncProofId("slack", row.account_key, "conversation", row.conversation_id, "messages"),
      row.account_key,
      scopeId,
      "messages",
      messagesComplete ? "complete" : "running",
      row.sync_mode,
      row.scan_started_at,
      row.last_observed_at,
      messagesComplete ? (row.history_complete_at ?? row.last_observed_at) : null,
      messagesComplete
        ? null
        : stringifyJson({
            historyCursor: row.history_cursor,
            conversationPhase: row.conversation_phase,
          }),
      stringifyJson({
        oldestMessageTs: row.oldest_message_ts,
        newestMessageTs: row.newest_message_ts,
      }),
      stringifyJson({
        knownConversationCount: row.known_conversation_count,
        threadRootCount: row.thread_root_count,
      }),
      firstDiscoveredAt,
      updatedAt,
    );

    if (
      row.thread_root_count > 0 ||
      row.conversation_phase === "threads" ||
      row.conversation_phase === "complete"
    ) {
      const repliesComplete = row.conversation_phase === "complete";
      upsertProof.run(
        buildSyncProofId("slack", row.account_key, "conversation", row.conversation_id, "replies"),
        row.account_key,
        scopeId,
        "replies",
        repliesComplete ? "complete" : "running",
        row.sync_mode,
        row.scan_started_at,
        row.last_observed_at,
        repliesComplete ? (row.replies_complete_at ?? row.last_observed_at) : null,
        repliesComplete
          ? null
          : stringifyJson({
              activeThreadTs: row.active_thread_ts,
              repliesCursor: row.replies_cursor,
              conversationPhase: row.conversation_phase,
            }),
        stringifyJson({
          oldestMessageTs: row.oldest_message_ts,
          newestMessageTs: row.newest_message_ts,
          completedThreadCount: row.completed_thread_count,
          pendingThreadCount: row.pending_thread_count,
        }),
        stringifyJson({
          threadRootCount: row.thread_root_count,
          completedThreadCount: row.completed_thread_count,
          pendingThreadCount: row.pending_thread_count,
        }),
        firstDiscoveredAt,
        updatedAt,
      );
    }
  }
}

function repairLegacySyncRunsIfNeeded(db: MigrationDatabase): void {
  if (!tableExists(db, "sync_runs") || columnExists(db, "sync_runs", "queued_at")) {
    return;
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_sync_runs_status_type_started;
    DROP INDEX IF EXISTS idx_sync_runs_platform_account_status_started;
    DROP INDEX IF EXISTS idx_sync_runs_status_type_queue;
    DROP INDEX IF EXISTS idx_sync_runs_platform_account_status_queue;

    ALTER TABLE sync_runs RENAME TO sync_runs_legacy_timing;
  `);
  if (tableExists(db, "sync_run_errors")) {
    db.exec(`ALTER TABLE sync_run_errors RENAME TO sync_run_errors_legacy_timing`);
  }

  db.exec(`
    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY,
      platform TEXT,
      account_key TEXT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      details_json TEXT
    );
  `);

  if (tableExists(db, "sync_run_errors_legacy_timing")) {
    db.exec(`
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
  }

  db.exec(`
    INSERT INTO sync_runs (
      id,
      platform,
      account_key,
      run_type,
      status,
      trigger,
      queued_at,
      started_at,
      finished_at,
      details_json
    )
    SELECT
      id,
      platform,
      account_key,
      run_type,
      status,
      trigger,
      COALESCE(started_at, strftime('%s','now') * 1000),
      CASE
        WHEN status IN ('ingesting', 'projecting', 'completed', 'failed') THEN started_at
        ELSE NULL
      END,
      finished_at,
      details_json
    FROM sync_runs_legacy_timing;
  `);

  if (tableExists(db, "sync_run_errors_legacy_timing")) {
    db.exec(`
      INSERT INTO sync_run_errors (
        id,
        sync_run_id,
        platform,
        account_key,
        error_code,
        error_message,
        details_json,
        created_at
      )
      SELECT
        id,
        sync_run_id,
        platform,
        account_key,
        error_code,
        error_message,
        details_json,
        created_at
      FROM sync_run_errors_legacy_timing;

      DROP TABLE sync_run_errors_legacy_timing;
    `);
  }

  db.exec(`
    DROP TABLE sync_runs_legacy_timing;

    CREATE INDEX IF NOT EXISTS idx_sync_runs_status_type_queue
    ON sync_runs(status, run_type, queued_at);

    CREATE INDEX IF NOT EXISTS idx_sync_runs_platform_account_status_queue
    ON sync_runs(platform, account_key, status, queued_at);
  `);
}

function repairLegacyMessageAttachmentsIfNeeded(db: MigrationDatabase): void {
  if (!tableExists(db, "message_attachments")) {
    return;
  }

  addColumnIfMissing(db, "message_attachments", "access_kind TEXT");
  addColumnIfMissing(db, "message_attachments", "access_ref_json TEXT");
  addColumnIfMissing(db, "message_attachments", "preview_ref_json TEXT");
  addColumnIfMissing(db, "message_attachments", "availability_status TEXT");
  addColumnIfMissing(db, "message_attachments", "provider_metadata_json TEXT");

  db.exec(`
    UPDATE message_attachments
    SET
      access_kind = CASE
        WHEN local_path IS NOT NULL AND trim(local_path) <> '' THEN 'local_path'
        WHEN remote_url IS NOT NULL AND trim(remote_url) <> '' THEN 'remote_url'
        ELSE 'none'
      END,
      access_ref_json = CASE
        WHEN local_path IS NOT NULL AND trim(local_path) <> '' THEN json_object('path', local_path)
        WHEN remote_url IS NOT NULL AND trim(remote_url) <> '' THEN json_object('url', remote_url)
        ELSE NULL
      END,
      availability_status = CASE
        WHEN local_path IS NOT NULL AND trim(local_path) <> '' THEN 'available'
        WHEN remote_url IS NOT NULL AND trim(remote_url) <> '' THEN 'available'
        ELSE 'metadata_only'
      END,
      provider_metadata_json = COALESCE(provider_metadata_json, metadata_json)
    WHERE access_kind IS NULL;
  `);
}

function ensureLegacySupportTables(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_backfill_proofs (
      id TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      team_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_name TEXT,
      conversation_family TEXT NOT NULL,
      sync_mode TEXT NOT NULL,
      scan_started_at INTEGER NOT NULL,
      known_conversation_count INTEGER NOT NULL,
      conversation_phase TEXT NOT NULL,
      history_complete INTEGER NOT NULL DEFAULT 0,
      history_cursor TEXT,
      thread_root_count INTEGER NOT NULL DEFAULT 0,
      completed_thread_count INTEGER NOT NULL DEFAULT 0,
      pending_thread_count INTEGER NOT NULL DEFAULT 0,
      active_thread_ts TEXT,
      replies_cursor TEXT,
      oldest_message_ts TEXT,
      newest_message_ts TEXT,
      first_discovered_at INTEGER NOT NULL,
      history_complete_at INTEGER,
      replies_complete_at INTEGER,
      last_observed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_key, conversation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_slack_backfill_proofs_account_phase
    ON slack_backfill_proofs(account_key, conversation_phase, updated_at);

    CREATE TABLE IF NOT EXISTS attachment_cache (
      id TEXT PRIMARY KEY,
      attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
      variant TEXT NOT NULL,
      status TEXT NOT NULL,
      cache_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      fetched_at INTEGER,
      last_accessed_at INTEGER,
      expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(attachment_id, variant)
    );

    CREATE INDEX IF NOT EXISTS idx_attachment_cache_status_accessed
    ON attachment_cache(status, last_accessed_at, updated_at);

    CREATE TABLE IF NOT EXISTS attachment_content (
      attachment_id TEXT PRIMARY KEY REFERENCES message_attachments(id) ON DELETE CASCADE,
      extractor TEXT,
      status TEXT NOT NULL,
      text_content TEXT,
      mime_type TEXT,
      extracted_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_content_fts USING fts5(
      attachment_id UNINDEXED,
      filename,
      title,
      content
    );
  `);
}

function rebuildMessagesFtsArtifacts(db: MigrationDatabase): void {
  if (!tableExists(db, "messages") || !tableExists(db, "conversations")) {
    return;
  }

  db.exec(`
    DROP TRIGGER IF EXISTS trg_messages_inserted_fts;
    DROP TRIGGER IF EXISTS trg_messages_updated_fts;
    DROP TRIGGER IF EXISTS trg_messages_deleted_fts;
    DROP TRIGGER IF EXISTS trg_message_attachments_inserted;
    DROP TRIGGER IF EXISTS trg_message_attachments_updated;
    DROP TRIGGER IF EXISTS trg_message_attachments_deleted;
    DROP TRIGGER IF EXISTS trg_message_reactions_inserted;
    DROP TRIGGER IF EXISTS trg_message_reactions_updated;
    DROP TRIGGER IF EXISTS trg_message_reactions_deleted;
    DROP TRIGGER IF EXISTS trg_contacts_name_updated;
    DROP TRIGGER IF EXISTS trg_conversations_name_updated;
    DROP TRIGGER IF EXISTS trg_conversation_participants_inserted;
    DROP TRIGGER IF EXISTS trg_conversation_participants_updated;
    DROP TRIGGER IF EXISTS trg_conversation_participants_deleted;
    DROP VIEW IF EXISTS message_fts_source;
    DROP TABLE IF EXISTS messages_fts;

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      sender_name,
      conversation_name,
      participant_names,
      attachment_text,
      content
    );

    CREATE VIEW message_fts_source AS
    SELECT
      m.rowid AS message_rowid,
      m.id AS message_id,
      COALESCE(m.sender_name, '') AS sender_name,
      COALESCE(m.conversation_name, '') AS conversation_name,
      COALESCE(conv.participant_names, '') AS participant_names,
      COALESCE((
        SELECT GROUP_CONCAT(
          TRIM(COALESCE(ma.filename, '') || ' ' || COALESCE(ma.title, '') || ' ' || COALESCE(ma.text_content, '')),
          ' '
        )
        FROM message_attachments ma
        WHERE ma.message_id = m.id
      ), '') AS attachment_text,
      COALESCE(m.content, '') AS content
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id;

    CREATE TRIGGER trg_messages_inserted_fts
    AFTER INSERT ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = NEW.rowid;
      INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
      SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
      FROM message_fts_source
      WHERE message_id = NEW.id;
    END;

    CREATE TRIGGER trg_messages_updated_fts
    AFTER UPDATE OF sender_name, conversation_name, content ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = NEW.rowid;
      INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
      SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
      FROM message_fts_source
      WHERE message_id = NEW.id;
    END;

    CREATE TRIGGER trg_messages_deleted_fts
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    END;
  `);

  if (tableExists(db, "message_attachments")) {
    db.exec(`
      CREATE TRIGGER trg_message_attachments_inserted
      AFTER INSERT ON message_attachments
      BEGIN
        UPDATE messages
        SET
          attachment_count = (
            SELECT COUNT(*) FROM message_attachments WHERE message_id = NEW.message_id
          ),
          updated_at = MAX(updated_at, NEW.updated_at)
        WHERE id = NEW.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = NEW.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.message_id;
      END;

      CREATE TRIGGER trg_message_attachments_updated
      AFTER UPDATE ON message_attachments
      BEGIN
        UPDATE messages
        SET
          attachment_count = (
            SELECT COUNT(*) FROM message_attachments WHERE message_id = NEW.message_id
          ),
          updated_at = MAX(updated_at, NEW.updated_at)
        WHERE id = NEW.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = NEW.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.message_id;
      END;

      CREATE TRIGGER trg_message_attachments_deleted
      AFTER DELETE ON message_attachments
      BEGIN
        UPDATE messages
        SET attachment_count = (
          SELECT COUNT(*) FROM message_attachments WHERE message_id = OLD.message_id
        )
        WHERE id = OLD.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = OLD.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = OLD.message_id;
      END;
    `);
  }

  if (tableExists(db, "message_reactions")) {
    db.exec(`
      CREATE TRIGGER trg_message_reactions_inserted
      AFTER INSERT ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = NEW.message_id AND is_active = 1
        )
        WHERE id = NEW.message_id;
      END;

      CREATE TRIGGER trg_message_reactions_updated
      AFTER UPDATE ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = NEW.message_id AND is_active = 1
        )
        WHERE id = NEW.message_id;
      END;

      CREATE TRIGGER trg_message_reactions_deleted
      AFTER DELETE ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = OLD.message_id AND is_active = 1
        )
        WHERE id = OLD.message_id;
      END;
    `);
  }

  if (
    tableExists(db, "contacts") &&
    tableExists(db, "conversation_participants") &&
    tableExists(db, "timeline_events") &&
    tableExists(db, "message_reactions")
  ) {
    db.exec(`
      CREATE TRIGGER trg_contacts_name_updated
      AFTER UPDATE OF name ON contacts
      BEGIN
        UPDATE messages
        SET sender_name = NEW.name
        WHERE sender_contact_id = NEW.id;

        UPDATE conversation_participants
        SET participant_name = NEW.name
        WHERE contact_id = NEW.id;

        UPDATE timeline_events
        SET actor_name = NEW.name
        WHERE actor_contact_id = NEW.id;

        UPDATE message_reactions
        SET reactor_name = NEW.name
        WHERE reactor_contact_id = NEW.id;

        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = conversations.id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id IN (
          SELECT DISTINCT conversation_id
          FROM conversation_participants
          WHERE contact_id = NEW.id
        );

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE sender_contact_id = NEW.id
          UNION
          SELECT m.rowid
          FROM messages m
          JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
          WHERE cp.contact_id = NEW.id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE sender_contact_id = NEW.id
          UNION
          SELECT m.id
          FROM messages m
          JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
          WHERE cp.contact_id = NEW.id
        );
      END;
    `);
  }

  if (tableExists(db, "conversation_participants")) {
    db.exec(`
      CREATE TRIGGER trg_conversations_name_updated
      AFTER UPDATE OF name ON conversations
      BEGIN
        UPDATE messages
        SET conversation_name = NEW.name
        WHERE conversation_id = NEW.id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.id
        );
      END;

      CREATE TRIGGER trg_conversation_participants_inserted
      AFTER INSERT ON conversation_participants
      BEGIN
        UPDATE conversation_participants
        SET participant_name = COALESCE(
          (SELECT name FROM contacts WHERE id = NEW.contact_id),
          participant_name
        )
        WHERE conversation_id = NEW.conversation_id
          AND contact_id = NEW.contact_id
          AND COALESCE(source_participant_key, '') = COALESCE(NEW.source_participant_key, '');

        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = NEW.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = NEW.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );
      END;

      CREATE TRIGGER trg_conversation_participants_updated
      AFTER UPDATE ON conversation_participants
      BEGIN
        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = NEW.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = NEW.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );
      END;

      CREATE TRIGGER trg_conversation_participants_deleted
      AFTER DELETE ON conversation_participants
      BEGIN
        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = OLD.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = OLD.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = OLD.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = OLD.conversation_id
        );
      END;
    `);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0000_prepare_schema_migrations_and_legacy_sync_runs",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `);
      repairLegacySyncRunsIfNeeded(db);
    },
  },
  {
    id: "0001_bootstrap_current_schema",
    legacyIds: ["0014_messages_fts_rowid_alignment"],
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key)
      );

      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_cursor_json TEXT,
        raw_ingest_watermark INTEGER NOT NULL DEFAULT 0,
        sync_mode TEXT NOT NULL DEFAULT 'full',
        last_full_sync_at INTEGER,
        last_success_at INTEGER,
        last_error_at INTEGER,
        last_error_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key)
      );

      CREATE TABLE IF NOT EXISTS sync_scopes (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        parent_scope_id TEXT REFERENCES sync_scopes(id) ON DELETE CASCADE,
        display_name TEXT,
        metadata_json TEXT,
        first_discovered_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, scope_kind, scope_key)
      );

      CREATE TABLE IF NOT EXISTS sync_proofs (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
        proof_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        sync_mode TEXT,
        run_started_at INTEGER,
        last_observed_at INTEGER NOT NULL,
        completed_at INTEGER,
        fresh_until INTEGER,
        resume_cursor_json TEXT,
        coverage_json TEXT,
        stats_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, scope_id, proof_kind)
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        account_key TEXT,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_run_errors (
        id TEXT PRIMARY KEY,
        sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
        platform TEXT,
        account_key TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_backfill_proofs (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        conversation_name TEXT,
        conversation_family TEXT NOT NULL,
        sync_mode TEXT NOT NULL,
        scan_started_at INTEGER NOT NULL,
        known_conversation_count INTEGER NOT NULL,
        conversation_phase TEXT NOT NULL,
        history_complete INTEGER NOT NULL DEFAULT 0,
        history_cursor TEXT,
        thread_root_count INTEGER NOT NULL DEFAULT 0,
        completed_thread_count INTEGER NOT NULL DEFAULT 0,
        pending_thread_count INTEGER NOT NULL DEFAULT 0,
        active_thread_ts TEXT,
        replies_cursor TEXT,
        oldest_message_ts TEXT,
        newest_message_ts TEXT,
        first_discovered_at INTEGER NOT NULL,
        history_complete_at INTEGER,
        replies_complete_at INTEGER,
        last_observed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_key, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS daemon_state (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'daemon'),
        pid INTEGER,
        started_at INTEGER,
        updated_at INTEGER,
        status TEXT NOT NULL,
        version TEXT,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_state (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
        projection_watermark INTEGER NOT NULL DEFAULT 0,
        last_projected_at INTEGER,
        last_rebuild_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO projection_state (
        singleton_key, projection_watermark, last_projected_at, last_rebuild_at, updated_at
      ) VALUES ('global', 0, NULL, NULL, strftime('%s','now') * 1000);

      CREATE TABLE IF NOT EXISTS raw_events (
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
        normalized_schema TEXT,
        provenance_json TEXT,
        source_version TEXT,
        UNIQUE(platform, account_key, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        name TEXT,
        photo_url TEXT,
        company TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_handles (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        platform TEXT,
        account_key TEXT,
        is_deterministic INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_sources (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_entity_key TEXT NOT NULL,
        profile_url TEXT,
        metadata_json TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_entity_key)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        native_conversation_key TEXT,
        type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        removal_reason TEXT,
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
      );

      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        source_participant_key TEXT,
        participant_name TEXT,
        role TEXT,
        is_self INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        joined_at INTEGER,
        left_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, contact_id, source_participant_key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        sender_source_key TEXT,
        sender_name TEXT,
        conversation_name TEXT,
        sent_at INTEGER NOT NULL,
        service TEXT,
        status TEXT,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        delivered_at INTEGER,
        read_at INTEGER,
        edited_at INTEGER,
        deleted_at INTEGER,
        reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        is_edited INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        reaction_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, platform_message_id)
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
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
        preview_ref_json TEXT,
        availability_status TEXT,
        provider_metadata_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_attachment_key)
      );

      CREATE TABLE IF NOT EXISTS message_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_reaction_key TEXT NOT NULL,
        reactor_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        reactor_source_key TEXT,
        reactor_name TEXT,
        emoji TEXT NOT NULL,
        reaction_type TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_reaction_key)
      );

      CREATE TABLE IF NOT EXISTS attachment_cache (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
        variant TEXT NOT NULL,
        status TEXT NOT NULL,
        cache_path TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        fetched_at INTEGER,
        last_accessed_at INTEGER,
        expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(attachment_id, variant)
      );

      CREATE TABLE IF NOT EXISTS attachment_content (
        attachment_id TEXT PRIMARY KEY REFERENCES message_attachments(id) ON DELETE CASCADE,
        extractor TEXT,
        status TEXT NOT NULL,
        text_content TEXT,
        mime_type TEXT,
        extracted_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_event_key TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        actor_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        actor_source_key TEXT,
        actor_name TEXT,
        subject_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        subject_source_key TEXT,
        event_at INTEGER NOT NULL,
        text TEXT,
        system_kind TEXT,
        call_provider TEXT,
        call_direction TEXT,
        call_status TEXT,
        call_medium TEXT,
        call_started_at INTEGER,
        call_duration_seconds INTEGER,
        call_ended_at INTEGER,
        call_disconnected_cause TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_event_key)
      );

      CREATE TABLE IF NOT EXISTS integration_states (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT,
        auth_state TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        connection_kind TEXT NOT NULL,
        sync_capable INTEGER NOT NULL,
        launch_strategy TEXT,
        launch_target TEXT,
        imported_from TEXT,
        artifact_paths_json TEXT,
        metadata_json TEXT,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key)
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        integration_state_id TEXT NOT NULL REFERENCES integration_states(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        native_pid INTEGER,
        requested_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        keychain_service TEXT,
        keychain_account TEXT,
        result_summary_json TEXT,
        error_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        target TEXT NOT NULL,
        thread_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        sender_name,
        conversation_name,
        participant_names,
        attachment_text,
        content
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS attachment_content_fts USING fts5(
        attachment_id UNINDEXED,
        filename,
        title,
        content
      );

      CREATE INDEX IF NOT EXISTS idx_source_accounts_lookup
      ON source_accounts(platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_sync_checkpoints_lookup
      ON sync_checkpoints(platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_sync_scopes_lookup
      ON sync_scopes(platform, account_key, scope_kind, scope_key);

      CREATE INDEX IF NOT EXISTS idx_sync_scopes_parent
      ON sync_scopes(parent_scope_id, updated_at);

      CREATE INDEX IF NOT EXISTS idx_sync_proofs_lookup
      ON sync_proofs(platform, account_key, scope_id, proof_kind);

      CREATE INDEX IF NOT EXISTS idx_sync_proofs_status
      ON sync_proofs(platform, account_key, status, updated_at);

      CREATE INDEX IF NOT EXISTS idx_sync_runs_status_type_queue
      ON sync_runs(status, run_type, queued_at);

      CREATE INDEX IF NOT EXISTS idx_sync_runs_platform_account_status_queue
      ON sync_runs(platform, account_key, status, queued_at);

      CREATE INDEX IF NOT EXISTS idx_raw_events_lookup
      ON raw_events(platform, account_key, observed_at);

      CREATE INDEX IF NOT EXISTS idx_raw_events_schema_lookup
      ON raw_events(platform, entity_kind, event_kind, normalized_schema);

      CREATE INDEX IF NOT EXISTS idx_contact_handles_lookup
      ON contact_handles(type, normalized_value, account_key);

      CREATE INDEX IF NOT EXISTS idx_contact_sources_contact
      ON contact_sources(contact_id, platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_conversation_participants_contact
      ON conversation_participants(contact_id);

      CREATE INDEX IF NOT EXISTS idx_timeline_events_actor_contact
      ON timeline_events(actor_contact_id);

      CREATE INDEX IF NOT EXISTS idx_message_reactions_reactor_contact
      ON message_reactions(reactor_contact_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_lookup
      ON conversations(platform, account_key, source_conversation_key);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, sent_at);

      CREATE INDEX IF NOT EXISTS idx_messages_sender
      ON messages(sender_contact_id, sent_at);

      CREATE INDEX IF NOT EXISTS idx_messages_platform_message
      ON messages(platform, account_key, platform_message_id);

      CREATE INDEX IF NOT EXISTS idx_message_attachments_message
      ON message_attachments(message_id);

      CREATE INDEX IF NOT EXISTS idx_message_reactions_message
      ON message_reactions(message_id, is_active);

      CREATE INDEX IF NOT EXISTS idx_attachment_cache_status_accessed
      ON attachment_cache(status, last_accessed_at, updated_at);

      CREATE INDEX IF NOT EXISTS idx_timeline_events_conversation
      ON timeline_events(conversation_id, event_at);

      CREATE INDEX IF NOT EXISTS idx_integration_states_platform
      ON integration_states(platform, enabled);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_platform_account
      ON auth_sessions(platform, account_key, requested_at DESC);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_state
      ON auth_sessions(state, requested_at DESC);

      CREATE INDEX IF NOT EXISTS idx_outbound_messages_status_scheduled
      ON outbound_messages(status, scheduled_for, created_at);

      CREATE INDEX IF NOT EXISTS idx_outbound_messages_platform_account_status
      ON outbound_messages(platform, account_key, status, scheduled_for);

      CREATE INDEX IF NOT EXISTS idx_slack_backfill_proofs_account_phase
      ON slack_backfill_proofs(account_key, conversation_phase, updated_at);

      CREATE VIEW IF NOT EXISTS message_fts_source AS
      SELECT
        m.rowid AS message_rowid,
        m.id AS message_id,
        COALESCE(m.sender_name, '') AS sender_name,
        COALESCE(m.conversation_name, '') AS conversation_name,
        COALESCE(conv.participant_names, '') AS participant_names,
        COALESCE((
          SELECT GROUP_CONCAT(
            TRIM(COALESCE(ma.filename, '') || ' ' || COALESCE(ma.title, '') || ' ' || COALESCE(ma.text_content, '')),
            ' '
          )
          FROM message_attachments ma
          WHERE ma.message_id = m.id
        ), '') AS attachment_text,
        COALESCE(m.content, '') AS content
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id;

      CREATE TRIGGER IF NOT EXISTS trg_messages_inserted_fts
      AFTER INSERT ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = NEW.rowid;
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_messages_updated_fts
      AFTER UPDATE OF sender_name, conversation_name, content ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = NEW.rowid;
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_messages_deleted_fts
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = OLD.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_attachments_inserted
      AFTER INSERT ON message_attachments
      BEGIN
        UPDATE messages
        SET
          attachment_count = (
            SELECT COUNT(*) FROM message_attachments WHERE message_id = NEW.message_id
          ),
          updated_at = MAX(updated_at, NEW.updated_at)
        WHERE id = NEW.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = NEW.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_attachments_updated
      AFTER UPDATE ON message_attachments
      BEGIN
        UPDATE messages
        SET
          attachment_count = (
            SELECT COUNT(*) FROM message_attachments WHERE message_id = NEW.message_id
          ),
          updated_at = MAX(updated_at, NEW.updated_at)
        WHERE id = NEW.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = NEW.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_attachments_deleted
      AFTER DELETE ON message_attachments
      BEGIN
        UPDATE messages
        SET attachment_count = (
          SELECT COUNT(*) FROM message_attachments WHERE message_id = OLD.message_id
        )
        WHERE id = OLD.message_id;
        DELETE FROM messages_fts
        WHERE rowid IN (SELECT rowid FROM messages WHERE id = OLD.message_id);
        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = OLD.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_reactions_inserted
      AFTER INSERT ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = NEW.message_id AND is_active = 1
        )
        WHERE id = NEW.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_reactions_updated
      AFTER UPDATE ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = NEW.message_id AND is_active = 1
        )
        WHERE id = NEW.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_reactions_deleted
      AFTER DELETE ON message_reactions
      BEGIN
        UPDATE messages
        SET reaction_count = (
          SELECT COUNT(*) FROM message_reactions WHERE message_id = OLD.message_id AND is_active = 1
        )
        WHERE id = OLD.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_contacts_name_updated
      AFTER UPDATE OF name ON contacts
      BEGIN
        UPDATE messages
        SET sender_name = NEW.name
        WHERE sender_contact_id = NEW.id;

        UPDATE conversation_participants
        SET participant_name = NEW.name
        WHERE contact_id = NEW.id;

        UPDATE timeline_events
        SET actor_name = NEW.name
        WHERE actor_contact_id = NEW.id;

        UPDATE message_reactions
        SET reactor_name = NEW.name
        WHERE reactor_contact_id = NEW.id;

        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = conversations.id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id IN (
          SELECT DISTINCT conversation_id
          FROM conversation_participants
          WHERE contact_id = NEW.id
        );

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE sender_contact_id = NEW.id
          UNION
          SELECT m.rowid
          FROM messages m
          JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
          WHERE cp.contact_id = NEW.id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE sender_contact_id = NEW.id
          UNION
          SELECT m.id
          FROM messages m
          JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
          WHERE cp.contact_id = NEW.id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_conversations_name_updated
      AFTER UPDATE OF name ON conversations
      BEGIN
        UPDATE messages
        SET conversation_name = NEW.name
        WHERE conversation_id = NEW.id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_conversation_participants_inserted
      AFTER INSERT ON conversation_participants
      BEGIN
        UPDATE conversation_participants
        SET participant_name = COALESCE(
          (SELECT name FROM contacts WHERE id = NEW.contact_id),
          participant_name
        )
        WHERE conversation_id = NEW.conversation_id
          AND contact_id = NEW.contact_id
          AND COALESCE(source_participant_key, '') = COALESCE(NEW.source_participant_key, '');

        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = NEW.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = NEW.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_conversation_participants_updated
      AFTER UPDATE ON conversation_participants
      BEGIN
        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = NEW.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = NEW.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_conversation_participants_deleted
      AFTER DELETE ON conversation_participants
      BEGIN
        UPDATE conversations
        SET participant_names = (
          SELECT GROUP_CONCAT(cp.participant_name, ' | ')
          FROM conversation_participants cp
          WHERE cp.conversation_id = OLD.conversation_id
            AND cp.is_active = 1
            AND cp.participant_name IS NOT NULL
            AND cp.participant_name <> ''
        )
        WHERE id = OLD.conversation_id;

        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE conversation_id = OLD.conversation_id
        );

        INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_rowid, message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = OLD.conversation_id
        );
      END;
    `,
  },
  {
    id: "0002_upgrade_existing_schema_columns",
    apply: (db) => {
      addColumnIfMissing(db, "raw_events", "normalized_schema TEXT");
      addColumnIfMissing(db, "raw_events", "provenance_json TEXT");
      addColumnIfMissing(db, "conversations", "is_active INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(db, "conversations", "removal_reason TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS projection_state (
          singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
          projection_watermark INTEGER NOT NULL DEFAULT 0,
          last_projected_at INTEGER,
          last_rebuild_at INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO projection_state (
          singleton_key, projection_watermark, last_projected_at, last_rebuild_at, updated_at
        ) VALUES ('global', 0, NULL, NULL, strftime('%s','now') * 1000)
      `);
      if (columnExists(db, "conversations", "subtype")) {
        db.exec(`
          UPDATE conversations
          SET is_active = CASE
            WHEN subtype = 'deleted' THEN 0
            ELSE is_active
          END,
          removal_reason = CASE
            WHEN subtype IS NOT NULL AND subtype <> '' THEN subtype
            ELSE removal_reason
          END
        `);
      }
      addColumnIfMissing(db, "timeline_events", "subject_source_key TEXT");
    },
  },
  {
    id: "0003_repair_conversation_removal_reason",
    apply: (db) => {
      addColumnIfMissing(db, "conversations", "removal_reason TEXT");
      if (columnExists(db, "conversations", "subtype")) {
        db.exec(`
          UPDATE conversations
          SET removal_reason = CASE
            WHEN subtype IS NOT NULL AND subtype <> '' THEN subtype
            ELSE removal_reason
          END
        `);
      }
    },
  },
  {
    id: "0004_repair_partial_legacy_bootstrap",
    apply: (db) => {
      repairLegacySyncRunsIfNeeded(db);
      repairLegacyMessageAttachmentsIfNeeded(db);
      ensureLegacySupportTables(db);
      rebuildMessagesFtsArtifacts(db);
    },
  },
  {
    id: "0005_add_contact_merge_decisions",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contact_merge_decisions (
          id TEXT PRIMARY KEY,
          decision_type TEXT NOT NULL,
          primary_contact_id TEXT NOT NULL,
          secondary_contact_id TEXT NOT NULL,
          canonical_contact_id TEXT NOT NULL,
          reason TEXT,
          created_by TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_contact_merge_decisions_secondary
        ON contact_merge_decisions(secondary_contact_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_contact_merge_decisions_canonical
        ON contact_merge_decisions(canonical_contact_id, created_at);
      `);
    },
  },
  {
    id: "0006_rename_contact_merge_columns",
    apply: (db) => {
      if (columnExists(db, "contact_merge_decisions", "left_contact_id")) {
        db.exec(`
          DROP INDEX IF EXISTS idx_contact_merge_decisions_right;
          ALTER TABLE contact_merge_decisions RENAME COLUMN left_contact_id TO primary_contact_id;
        `);
      }
      if (columnExists(db, "contact_merge_decisions", "right_contact_id")) {
        db.exec(`
          ALTER TABLE contact_merge_decisions RENAME COLUMN right_contact_id TO secondary_contact_id;
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_contact_merge_decisions_secondary
        ON contact_merge_decisions(secondary_contact_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_contact_merge_decisions_canonical
        ON contact_merge_decisions(canonical_contact_id, created_at);
      `);
    },
  },
  {
    id: "0007_add_generic_sync_proof_tables",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_scopes (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          account_key TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          parent_scope_id TEXT REFERENCES sync_scopes(id) ON DELETE CASCADE,
          display_name TEXT,
          metadata_json TEXT,
          first_discovered_at INTEGER NOT NULL,
          last_observed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(platform, account_key, scope_kind, scope_key)
        );

        CREATE TABLE IF NOT EXISTS sync_proofs (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          account_key TEXT NOT NULL,
          scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
          proof_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          sync_mode TEXT,
          run_started_at INTEGER,
          last_observed_at INTEGER NOT NULL,
          completed_at INTEGER,
          fresh_until INTEGER,
          resume_cursor_json TEXT,
          coverage_json TEXT,
          stats_json TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(platform, account_key, scope_id, proof_kind)
        );

        CREATE INDEX IF NOT EXISTS idx_sync_scopes_lookup
        ON sync_scopes(platform, account_key, scope_kind, scope_key);

        CREATE INDEX IF NOT EXISTS idx_sync_scopes_parent
        ON sync_scopes(parent_scope_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_sync_proofs_lookup
        ON sync_proofs(platform, account_key, scope_id, proof_kind);

        CREATE INDEX IF NOT EXISTS idx_sync_proofs_status
        ON sync_proofs(platform, account_key, status, updated_at);
      `);
    },
  },
  {
    id: "0008_migrate_slack_backfill_proofs_to_generic",
    apply: (db) => {
      migrateSlackBackfillProofsToGeneric(db);
    },
  },
  {
    id: "0009_add_contact_fanout_projection_indexes",
    legacyIds: ["0008_add_contact_fanout_projection_indexes"],
    apply: (db) => {
      if (tableExists(db, "conversation_participants")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_conversation_participants_contact
          ON conversation_participants(contact_id);
        `);
      }
      if (tableExists(db, "timeline_events")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_timeline_events_actor_contact
          ON timeline_events(actor_contact_id);
        `);
      }
      if (tableExists(db, "message_reactions")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_message_reactions_reactor_contact
          ON message_reactions(reactor_contact_id);
        `);
      }
    },
  },
  {
    id: "0010_add_timeline_call_fields",
    apply: (db) => {
      if (!tableExists(db, "timeline_events")) {
        return;
      }
      addColumnIfMissing(db, "timeline_events", "system_kind TEXT");
      addColumnIfMissing(db, "timeline_events", "call_provider TEXT");
      addColumnIfMissing(db, "timeline_events", "call_direction TEXT");
      addColumnIfMissing(db, "timeline_events", "call_status TEXT");
      addColumnIfMissing(db, "timeline_events", "call_medium TEXT");
      addColumnIfMissing(db, "timeline_events", "call_started_at INTEGER");
      addColumnIfMissing(db, "timeline_events", "call_duration_seconds INTEGER");
      addColumnIfMissing(db, "timeline_events", "call_ended_at INTEGER");
      addColumnIfMissing(db, "timeline_events", "call_disconnected_cause TEXT");
      db.exec(`
        UPDATE timeline_events
        SET system_kind = COALESCE(system_kind, 'provider_notice')
        WHERE event_kind = 'system_message'
      `);
    },
  },
  {
    id: "0011_remove_telegram_runtime_state",
    apply: (db) => {
      for (const tableName of [
        "integration_states",
        "auth_sessions",
        "sync_checkpoints",
        "source_accounts",
        "sync_proofs",
        "sync_scopes",
        "sync_runs",
        "sync_run_errors",
      ]) {
        if (tableExists(db, tableName) && columnExists(db, tableName, "platform")) {
          db.prepare(`DELETE FROM ${tableName} WHERE platform = 'telegram'`).run();
        }
      }
    },
  },
];
