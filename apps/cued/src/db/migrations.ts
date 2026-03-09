export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "0001_initial_local_cued_v2",
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
        projection_watermark INTEGER NOT NULL DEFAULT 0,
        sync_mode TEXT NOT NULL DEFAULT 'full',
        last_full_sync_at INTEGER,
        last_success_at INTEGER,
        last_error_at INTEGER,
        last_error_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key)
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
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

      CREATE TABLE IF NOT EXISTS daemon_state (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'daemon'),
        pid INTEGER,
        started_at INTEGER,
        updated_at INTEGER,
        status TEXT NOT NULL,
        version TEXT,
        details_json TEXT
      );

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
        source_version TEXT,
        UNIQUE(platform, account_key, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS contact_observations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_entity_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        handles_json TEXT NOT NULL,
        raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL,
        UNIQUE(platform, account_key, source_entity_key, observed_at)
      );

      CREATE TABLE IF NOT EXISTS conversation_observations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL,
        UNIQUE(platform, account_key, source_conversation_key, observed_at)
      );

      CREATE TABLE IF NOT EXISTS message_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_message_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        sender_source_key TEXT,
        content_original TEXT,
        content_current TEXT,
        status_delivery TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        edited INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS message_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        platform TEXT NOT NULL,
        source_reaction_key TEXT NOT NULL,
        emoji TEXT NOT NULL,
        reactor_contact_id TEXT,
        reactor_source_key TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL,
        UNIQUE(platform, source_reaction_key)
      );

      CREATE TABLE IF NOT EXISTS participant_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        participant_source_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        metadata_json TEXT,
        raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        preferred_display_name TEXT,
        preferred_photo_url TEXT,
        preferred_company TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_handles (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        handle_type TEXT NOT NULL,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        platform_scope TEXT,
        account_scope TEXT,
        is_deterministic_key INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_field_values (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        field_value TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_key TEXT,
        source_entity_key TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        observed_at INTEGER NOT NULL,
        is_current_best INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS contact_sources (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_entity_key TEXT NOT NULL,
        source_profile_url TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT,
        UNIQUE(platform, account_key, source_entity_key)
      );

      CREATE TABLE IF NOT EXISTS contact_merge_decisions (
        id TEXT PRIMARY KEY,
        decision_type TEXT NOT NULL,
        left_contact_id TEXT,
        right_contact_id TEXT,
        canonical_contact_id TEXT,
        reason TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        conversation_type TEXT NOT NULL,
        display_name TEXT,
        topic TEXT,
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
        role TEXT,
        joined_at INTEGER,
        left_at INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        source_participant_key TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, contact_id, source_participant_key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_message_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        sender_source_key TEXT,
        sent_at INTEGER NOT NULL,
        content_original TEXT,
        content_current TEXT,
        status_delivery TEXT,
        delivered_at INTEGER,
        read_at INTEGER,
        edited_at INTEGER,
        deleted_at INTEGER,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        is_edited INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        attachment_metadata_json TEXT,
        reaction_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_message_key)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        platform,
        sender_name,
        conversation_name,
        participant_names,
        content
      );

      CREATE INDEX IF NOT EXISTS idx_source_accounts_lookup
      ON source_accounts(platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_sync_checkpoints_lookup
      ON sync_checkpoints(platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_raw_events_lookup
      ON raw_events(platform, account_key, observed_at);

      CREATE INDEX IF NOT EXISTS idx_message_events_lookup
      ON message_events(platform, account_key, source_message_key, event_at);

      CREATE INDEX IF NOT EXISTS idx_contact_handles_lookup
      ON contact_handles(handle_type, normalized_value, account_scope);

      CREATE INDEX IF NOT EXISTS idx_contact_field_values_contact
      ON contact_field_values(contact_id, field_name, is_current_best);

      CREATE INDEX IF NOT EXISTS idx_contact_sources_contact
      ON contact_sources(contact_id, platform, account_key);

      CREATE INDEX IF NOT EXISTS idx_conversations_lookup
      ON conversations(platform, account_key, source_conversation_key);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, sent_at);

      CREATE INDEX IF NOT EXISTS idx_messages_sender
      ON messages(sender_contact_id, sent_at);

      CREATE VIEW IF NOT EXISTS contact_directory AS
      SELECT
        c.id,
        c.kind,
        c.preferred_display_name,
        c.preferred_photo_url,
        c.preferred_company,
        c.archived,
        c.created_at,
        c.updated_at,
        (
          SELECT GROUP_CONCAT(h.value, ' | ')
          FROM contact_handles h
          WHERE h.contact_id = c.id
        ) AS handles,
        (
          SELECT GROUP_CONCAT(DISTINCT cs.platform)
          FROM contact_sources cs
          WHERE cs.contact_id = c.id
        ) AS source_platforms,
        (
          SELECT MAX(m.sent_at)
          FROM messages m
          WHERE m.sender_contact_id = c.id
             OR EXISTS (
               SELECT 1
               FROM conversation_participants cp
               WHERE cp.conversation_id = m.conversation_id
                 AND cp.contact_id = c.id
             )
        ) AS last_message_at
      FROM contacts c;

      CREATE VIEW IF NOT EXISTS contact_provenance_summary AS
      SELECT
        c.id AS contact_id,
        c.preferred_display_name,
        cfv.field_name,
        cfv.field_value,
        cfv.platform,
        cfv.account_key,
        cfv.source_entity_key,
        cfv.priority,
        cfv.observed_at,
        cfv.is_current_best
      FROM contacts c
      JOIN contact_field_values cfv ON cfv.contact_id = c.id;

      CREATE VIEW IF NOT EXISTS conversation_directory AS
      SELECT
        conv.id,
        conv.platform,
        conv.account_key,
        conv.source_conversation_key,
        conv.conversation_type,
        conv.display_name,
        conv.topic,
        conv.last_message_at,
        conv.last_message_preview,
        conv.unread_count,
        conv.created_at,
        conv.updated_at,
        (
          SELECT GROUP_CONCAT(c.preferred_display_name, ' | ')
          FROM conversation_participants cp
          JOIN contacts c ON c.id = cp.contact_id
          WHERE cp.conversation_id = conv.id
            AND cp.is_active = 1
        ) AS participant_names
      FROM conversations conv;

      CREATE VIEW IF NOT EXISTS message_timeline AS
      SELECT
        m.id,
        m.platform,
        m.account_key,
        m.source_message_key,
        m.conversation_id,
        conv.display_name AS conversation_name,
        m.sender_contact_id,
        sender.preferred_display_name AS sender_name,
        m.sent_at,
        m.content_original,
        m.content_current,
        m.status_delivery,
        m.delivered_at,
        m.read_at,
        m.edited_at,
        m.deleted_at,
        m.is_deleted,
        m.is_edited,
        m.has_attachments,
        m.reaction_count,
        (
          SELECT GROUP_CONCAT(c.preferred_display_name, ' | ')
          FROM conversation_participants cp
          JOIN contacts c ON c.id = cp.contact_id
          WHERE cp.conversation_id = m.conversation_id
            AND cp.is_active = 1
        ) AS participant_names
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id
      LEFT JOIN contacts sender ON sender.id = m.sender_contact_id;

      CREATE VIEW IF NOT EXISTS message_search_results AS
      SELECT
        mt.*,
        f.content AS indexed_content
      FROM message_timeline mt
      JOIN messages_fts f ON f.message_id = mt.id;

      CREATE VIEW IF NOT EXISTS message_reaction_summary AS
      SELECT
        mr.message_id,
        GROUP_CONCAT(mr.emoji || ':' || COALESCE(c.preferred_display_name, mr.reactor_source_key), ' | ') AS reactions
      FROM message_reactions mr
      LEFT JOIN contacts c ON c.id = mr.reactor_contact_id
      WHERE mr.is_active = 1
      GROUP BY mr.message_id;
    `,
  },
  {
    id: "0002_integration_states",
    sql: `
      CREATE TABLE IF NOT EXISTS integration_states (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT,
        auth_state TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        connection_kind TEXT NOT NULL,
        sync_capable INTEGER NOT NULL DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS idx_integration_states_platform
      ON integration_states(platform, enabled);
    `,
  },
  {
    id: "0003_auth_sessions",
    sql: `
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

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_platform_account
      ON auth_sessions(platform, account_key, requested_at DESC);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_state
      ON auth_sessions(state, requested_at DESC);
    `,
  },
];
