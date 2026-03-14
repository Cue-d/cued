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
  {
    id: "0004_projection_state",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_state (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
        projection_watermark INTEGER NOT NULL DEFAULT 0,
        last_projected_at INTEGER,
        last_rebuild_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO projection_state (
        singleton_key,
        projection_watermark,
        last_projected_at,
        last_rebuild_at,
        updated_at
      ) VALUES (
        'global',
        0,
        NULL,
        NULL,
        strftime('%s','now') * 1000
      );
    `,
  },
  {
    id: "0005_projection_vnext_cut_down",
    sql: `
      DROP VIEW IF EXISTS message_reaction_summary;
      DROP VIEW IF EXISTS message_search_results;
      DROP VIEW IF EXISTS message_timeline;
      DROP VIEW IF EXISTS conversation_directory;
      DROP VIEW IF EXISTS contact_provenance_summary;
      DROP VIEW IF EXISTS contact_directory;
      DROP VIEW IF EXISTS message_fts_source;

      DROP TRIGGER IF EXISTS trg_contacts_name_updated;
      DROP TRIGGER IF EXISTS trg_conversations_name_updated;
      DROP TRIGGER IF EXISTS trg_conversation_participants_inserted;
      DROP TRIGGER IF EXISTS trg_conversation_participants_updated;
      DROP TRIGGER IF EXISTS trg_conversation_participants_deleted;
      DROP TRIGGER IF EXISTS trg_messages_inserted_fts;
      DROP TRIGGER IF EXISTS trg_messages_updated_fts;
      DROP TRIGGER IF EXISTS trg_messages_deleted_fts;
      DROP TRIGGER IF EXISTS trg_message_attachments_inserted;
      DROP TRIGGER IF EXISTS trg_message_attachments_updated;
      DROP TRIGGER IF EXISTS trg_message_attachments_deleted;
      DROP TRIGGER IF EXISTS trg_message_reactions_inserted;
      DROP TRIGGER IF EXISTS trg_message_reactions_updated;
      DROP TRIGGER IF EXISTS trg_message_reactions_deleted;

      DROP INDEX IF EXISTS idx_message_events_lookup;
      DROP INDEX IF EXISTS idx_contact_field_values_contact;
      DROP INDEX IF EXISTS idx_contact_handles_lookup;
      DROP INDEX IF EXISTS idx_contact_sources_contact;
      DROP INDEX IF EXISTS idx_conversations_lookup;
      DROP INDEX IF EXISTS idx_messages_conversation;
      DROP INDEX IF EXISTS idx_messages_sender;
      DROP TABLE IF EXISTS messages_fts;

      DROP TABLE IF EXISTS message_events;
      DROP TABLE IF EXISTS participant_events;
      DROP TABLE IF EXISTS contact_observations;
      DROP TABLE IF EXISTS conversation_observations;
      DROP TABLE IF EXISTS contact_field_values;
      DROP TABLE IF EXISTS message_attachments;
      DROP TABLE IF EXISTS timeline_events;
      DROP TABLE IF EXISTS message_reactions;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS conversation_participants;
      DROP TABLE IF EXISTS conversations;
      DROP TABLE IF EXISTS contact_handles;
      DROP TABLE IF EXISTS contact_sources;
      DROP TABLE IF EXISTS contacts;

      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        name TEXT,
        photo_url TEXT,
        company TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE contact_handles (
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

      CREATE TABLE contact_sources (
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
      );

      CREATE TABLE conversation_participants (
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

      CREATE TABLE messages (
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

      CREATE TABLE message_attachments (
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
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_attachment_key)
      );

      CREATE TABLE message_reactions (
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

      CREATE TABLE timeline_events (
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
        event_at INTEGER NOT NULL,
        text TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_event_key)
      );

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        sender_name,
        conversation_name,
        participant_names,
        attachment_text,
        content
      );

      CREATE INDEX idx_contact_handles_lookup
      ON contact_handles(type, normalized_value, account_key);

      CREATE INDEX idx_contact_sources_contact
      ON contact_sources(contact_id, platform, account_key);

      CREATE INDEX idx_conversations_lookup
      ON conversations(platform, account_key, source_conversation_key);

      CREATE INDEX idx_messages_conversation
      ON messages(conversation_id, sent_at);

      CREATE INDEX idx_messages_sender
      ON messages(sender_contact_id, sent_at);

      CREATE INDEX idx_messages_platform_message
      ON messages(platform, account_key, platform_message_id);

      CREATE INDEX idx_message_attachments_message
      ON message_attachments(message_id);

      CREATE INDEX idx_message_reactions_message
      ON message_reactions(message_id, is_active);

      CREATE INDEX idx_timeline_events_conversation
      ON timeline_events(conversation_id, event_at);

      CREATE VIEW message_fts_source AS
      SELECT
        m.id AS message_id,
        COALESCE(m.sender_name, '') AS sender_name,
        COALESCE(m.conversation_name, '') AS conversation_name,
        COALESCE(conv.participant_names, '') AS participant_names,
        COALESCE((
          SELECT GROUP_CONCAT(TRIM(COALESCE(ma.filename, '') || ' ' || COALESCE(ma.title, '') || ' ' || COALESCE(ma.text_content, '')), ' ')
          FROM message_attachments ma
          WHERE ma.message_id = m.id
        ), '') AS attachment_text,
        COALESCE(m.content, '') AS content
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id;

      CREATE TRIGGER trg_messages_inserted_fts
      AFTER INSERT ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = NEW.id;
        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.id;
      END;

      CREATE TRIGGER trg_messages_updated_fts
      AFTER UPDATE OF sender_name, conversation_name, content ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = NEW.id;
        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = NEW.id;
      END;

      CREATE TRIGGER trg_messages_deleted_fts
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = OLD.id;
      END;

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
        DELETE FROM messages_fts WHERE message_id = NEW.message_id;
        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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
        DELETE FROM messages_fts WHERE message_id = NEW.message_id;
        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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
        DELETE FROM messages_fts WHERE message_id = OLD.message_id;
        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id = OLD.message_id;
      END;

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
        WHERE message_id IN (
          SELECT id FROM messages WHERE sender_contact_id = NEW.id
          UNION
          SELECT m.id
          FROM messages m
          JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
          WHERE cp.contact_id = NEW.id
        );

        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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

      CREATE TRIGGER trg_conversations_name_updated
      AFTER UPDATE OF name ON conversations
      BEGIN
        UPDATE messages
        SET conversation_name = NEW.name
        WHERE conversation_id = NEW.id;

        DELETE FROM messages_fts
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.id
        );

        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = NEW.conversation_id
        );

        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
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
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = OLD.conversation_id
        );

        INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
        SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
        FROM message_fts_source
        WHERE message_id IN (
          SELECT id FROM messages WHERE conversation_id = OLD.conversation_id
        );
      END;
    `,
  },
  {
    id: "0006_sync_run_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_sync_runs_status_type_started
      ON sync_runs(status, run_type, started_at);

      CREATE INDEX IF NOT EXISTS idx_sync_runs_platform_account_status_started
      ON sync_runs(platform, account_key, status, started_at);
    `,
  },
  {
    id: "0007_projection_trigger_cleanup",
    sql: `
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
    `,
  },
  {
    id: "0008_outbound_messages",
    sql: `
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

      CREATE INDEX IF NOT EXISTS idx_outbound_messages_status_scheduled
      ON outbound_messages(status, scheduled_for, created_at);

      CREATE INDEX IF NOT EXISTS idx_outbound_messages_platform_account_status
      ON outbound_messages(platform, account_key, status, scheduled_for);
    `,
  },
  {
    id: "0009_app_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: "0010_requestable_sync_capable_backfill",
    sql: `
      UPDATE integration_states
      SET sync_capable = CASE
        WHEN auth_state = 'authenticated' AND platform IN ('slack', 'linkedin', 'signal', 'whatsapp') THEN 1
        WHEN platform IN ('slack', 'linkedin', 'signal', 'whatsapp') THEN 0
        ELSE sync_capable
      END,
      updated_at = strftime('%s','now') * 1000
      WHERE platform IN ('slack', 'linkedin', 'signal', 'whatsapp');
    `,
  },
  {
    id: "0011_attachment_access_and_content",
    sql: `
      ALTER TABLE message_attachments ADD COLUMN access_kind TEXT;
      ALTER TABLE message_attachments ADD COLUMN access_ref_json TEXT;
      ALTER TABLE message_attachments ADD COLUMN preview_ref_json TEXT;
      ALTER TABLE message_attachments ADD COLUMN availability_status TEXT;
      ALTER TABLE message_attachments ADD COLUMN provider_metadata_json TEXT;

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
        provider_metadata_json = metadata_json
      WHERE access_kind IS NULL;

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
    `,
  },
];
