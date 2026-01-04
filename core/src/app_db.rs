//! Dumb data store for prm.db (app's SQLite database).

use pyo3::prelude::*;
use rusqlite::{Connection, params};

use crate::models::{
    Attachment, PendingEmbedding, Person, PrmChat, PrmMessage, StoredEmbedding, SyncAttachment,
    SyncChat, SyncMessage, UnansweredChat,
};
use crate::utils::now_timestamp;

/// Internal constructor for testing (bypasses PyO3).
#[cfg(test)]
impl AppDb {
    fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        Self { conn }
    }
}

/// App database wrapper.
#[pyclass(unsendable)]
pub struct AppDb {
    conn: Connection,
}

#[pymethods]
impl AppDb {
    /// Open or create the database at the given path.
    #[new]
    pub fn open(path: &str) -> PyResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            pyo3::exceptions::PyIOError::new_err(format!("Failed to open db: {}", e))
        })?;
        Ok(Self { conn })
    }

    /// Initialize the database schema.
    pub fn init_schema(&self) -> PyResult<()> {
        self.conn
            .execute_batch(
                "
            -- Enable foreign key enforcement
            PRAGMA foreign_keys = ON;

            -- ============================================
            -- PEOPLE: Merged handles + contacts
            -- Each (identifier, service) pair gets its own row
            -- ============================================
            CREATE TABLE IF NOT EXISTS people (
                id INTEGER PRIMARY KEY,
                identifier TEXT NOT NULL,
                name TEXT NOT NULL,
                service TEXT NOT NULL,
                is_contact INTEGER NOT NULL DEFAULT 0,
                phones TEXT,
                emails TEXT,
                company TEXT,
                notes TEXT,
                synced_at INTEGER NOT NULL,
                UNIQUE(identifier, service)
            );
            CREATE INDEX IF NOT EXISTS idx_people_identifier ON people(identifier);
            CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);

            -- ============================================
            -- CHATS: Conversations
            -- ============================================
            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY,
                identifier TEXT NOT NULL,
                name TEXT,
                is_group INTEGER NOT NULL,
                synced_at INTEGER NOT NULL
            );

            -- ============================================
            -- CHAT PARTICIPANTS
            -- ============================================
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                person_id INTEGER NOT NULL REFERENCES people(id),
                PRIMARY KEY (chat_id, person_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_participants_person ON chat_participants(person_id);

            -- ============================================
            -- MESSAGES: Pre-resolved sender
            -- ============================================
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                sender_id INTEGER REFERENCES people(id),
                text TEXT,
                timestamp INTEGER NOT NULL,
                is_from_me INTEGER NOT NULL,
                is_read INTEGER NOT NULL,
                read_at INTEGER,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                synced_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);

            -- ============================================
            -- ATTACHMENTS: Metadata only
            -- ============================================
            CREATE TABLE IF NOT EXISTS attachments (
                id INTEGER PRIMARY KEY,
                message_id INTEGER NOT NULL REFERENCES messages(id),
                filename TEXT,
                path TEXT,
                mime_type TEXT,
                uti TEXT,
                size INTEGER,
                is_outgoing INTEGER NOT NULL,
                created_at INTEGER,
                synced_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

            -- ============================================
            -- SYNC STATE
            -- ============================================
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_message_rowid', 0);
            INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_attachment_rowid', 0);

            -- ============================================
            -- ACTIONS: Task queue
            -- ============================================
            CREATE TABLE IF NOT EXISTS actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                priority INTEGER NOT NULL DEFAULT 50,
                chat_id INTEGER REFERENCES chats(id),
                person_id INTEGER REFERENCES people(id),
                message_id INTEGER REFERENCES messages(id),
                payload TEXT,
                created_at INTEGER NOT NULL,
                remind_at INTEGER,
                snoozed_until INTEGER,
                completed_at INTEGER,
                discarded_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
            CREATE INDEX IF NOT EXISTS idx_actions_priority ON actions(status, priority DESC, created_at);
            CREATE INDEX IF NOT EXISTS idx_actions_chat ON actions(chat_id);
            CREATE INDEX IF NOT EXISTS idx_actions_person ON actions(person_id);
            CREATE INDEX IF NOT EXISTS idx_actions_remind ON actions(remind_at) WHERE remind_at IS NOT NULL;

            -- ============================================
            -- FTS5: Full-text search for messages
            -- ============================================
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                text,
                content='messages',
                content_rowid='id',
                tokenize='porter unicode61'
            );

            -- ============================================
            -- EMBEDDINGS: Semantic search infrastructure
            -- ============================================
            CREATE TABLE IF NOT EXISTS embedding_queue (
                message_id INTEGER PRIMARY KEY REFERENCES messages(id),
                queued_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON embedding_queue(status, queued_at);

            CREATE TABLE IF NOT EXISTS message_embeddings (
                message_id INTEGER PRIMARY KEY REFERENCES messages(id),
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                embedding BLOB NOT NULL,
                model_version TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_message_embeddings_chat ON message_embeddings(chat_id);

            CREATE TABLE IF NOT EXISTS contact_embeddings (
                person_id INTEGER PRIMARY KEY REFERENCES people(id),
                embedding BLOB NOT NULL,
                message_count INTEGER NOT NULL,
                model_version TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
                updated_at INTEGER NOT NULL
            );
            ",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Schema error: {}", e))
            })?;
        Ok(())
    }

    /// Ensure FTS5 triggers exist (safe to call multiple times).
    pub fn ensure_fts_triggers(&self) -> PyResult<()> {
        self.conn
            .execute_batch(
                "
            -- Trigger to update FTS when message is inserted
            CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
            BEGIN
                INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
            END;

            -- Trigger to update FTS when message is updated
            CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
            BEGIN
                UPDATE messages_fts SET text = new.text WHERE rowid = new.id;
            END;

            -- Trigger to delete from FTS when message is deleted
            CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
            BEGIN
                DELETE FROM messages_fts WHERE rowid = old.id;
            END;
            ",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("FTS trigger error: {}", e))
            })?;
        Ok(())
    }

    // ============================================
    // SYNC STATE METHODS
    // ============================================

    /// Get a sync state value by key.
    pub fn get_sync_state(&self, key: &str) -> PyResult<i64> {
        self.conn
            .query_row("SELECT value FROM sync_state WHERE key = ?", [key], |row| {
                row.get(0)
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Sync state error: {}", e))
            })
    }

    /// Set a sync state value by key.
    pub fn set_sync_state(&self, key: &str, value: i64) -> PyResult<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
                params![key, value],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Sync state error: {}", e))
            })?;
        Ok(())
    }

    // ============================================
    // PEOPLE SYNC METHODS
    // ============================================

    /// Upsert a person (handle + resolved contact info).
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_person(
        &self,
        id: i64,
        identifier: &str,
        name: &str,
        service: &str,
        is_contact: bool,
        phones: Option<&str>,
        emails: Option<&str>,
        company: Option<&str>,
        notes: Option<&str>,
    ) -> PyResult<()> {
        let now = now_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO people
                 (id, identifier, name, service, is_contact, phones, emails, company, notes, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    identifier,
                    name,
                    service,
                    is_contact as i32,
                    phones,
                    emails,
                    company,
                    notes,
                    now,
                ],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Upsert person error: {}", e))
            })?;
        Ok(())
    }

    /// Get a person by ID.
    pub fn get_person(&self, id: i64) -> PyResult<Option<Person>> {
        let result = self.conn.query_row(
            "SELECT id, identifier, name, service, is_contact, phones, emails, company, notes
             FROM people WHERE id = ?",
            [id],
            |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    service: row.get(3)?,
                    is_contact: row.get::<_, i32>(4)? != 0,
                    phones: row.get(5)?,
                    emails: row.get(6)?,
                    company: row.get(7)?,
                    notes: row.get(8)?,
                })
            },
        );
        match result {
            Ok(person) => Ok(Some(person)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                "Get person error: {}",
                e
            ))),
        }
    }

    // ============================================
    // CHATS SYNC METHODS
    // ============================================

    /// Upsert a chat.
    pub fn upsert_chat(&self, chat: &SyncChat, name: &str) -> PyResult<()> {
        let now = now_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO chats (id, identifier, name, is_group, synced_at)
                 VALUES (?, ?, ?, ?, ?)",
                params![chat.id, chat.identifier, name, chat.is_group as i32, now,],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Upsert chat error: {}", e))
            })?;
        Ok(())
    }

    /// Bulk upsert chat participants.
    /// Takes a list of (chat_id, handle_id) tuples - handle_id is used as person_id.
    /// Uses INSERT OR REPLACE to safely update without deleting unrelated participants.
    pub fn replace_chat_participants(&mut self, participants: Vec<(i64, i64)>) -> PyResult<()> {
        let tx = self.conn.transaction().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e))
        })?;

        // Collect all chat_ids we're updating to delete only their old participants
        let chat_ids: std::collections::HashSet<i64> =
            participants.iter().map(|(chat_id, _)| *chat_id).collect();

        // Delete participants only for chats we're updating
        for chat_id in &chat_ids {
            tx.execute(
                "DELETE FROM chat_participants WHERE chat_id = ?",
                params![chat_id],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Delete participants error: {}",
                    e
                ))
            })?;
        }

        // Insert all participants
        for (chat_id, person_id) in participants {
            tx.execute(
                "INSERT INTO chat_participants (chat_id, person_id) VALUES (?, ?)",
                params![chat_id, person_id],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Insert participant error: {}",
                    e
                ))
            })?;
        }

        tx.commit().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Commit error: {}", e))
        })?;

        Ok(())
    }

    // ============================================
    // MESSAGES SYNC METHODS
    // ============================================

    /// Insert messages in batch.
    pub fn insert_messages(&mut self, messages: Vec<SyncMessage>) -> PyResult<usize> {
        if messages.is_empty() {
            return Ok(0);
        }

        let tx = self.conn.transaction().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e))
        })?;

        let now = now_timestamp();
        let mut count = 0;

        for msg in &messages {
            // sender_id is handle_id if not from_me, NULL if from_me
            let sender_id = if msg.is_from_me {
                None
            } else if msg.handle_id > 0 {
                Some(msg.handle_id)
            } else {
                None
            };

            tx.execute(
                "INSERT OR REPLACE INTO messages (id, chat_id, sender_id, text, timestamp, is_from_me, is_read, read_at, has_attachments, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    msg.id,
                    msg.chat_id,
                    sender_id,
                    msg.text,
                    msg.timestamp,
                    msg.is_from_me as i32,
                    msg.is_read as i32,
                    msg.read_at,
                    msg.has_attachments as i32,
                    now,
                ],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Insert message error: {}", e))
            })?;
            count += 1;
        }

        tx.commit().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Commit error: {}", e))
        })?;

        Ok(count)
    }

    // ============================================
    // ATTACHMENTS SYNC METHODS
    // ============================================

    /// Insert attachments in batch.
    pub fn insert_attachments(&mut self, attachments: Vec<SyncAttachment>) -> PyResult<usize> {
        if attachments.is_empty() {
            return Ok(0);
        }

        let tx = self.conn.transaction().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e))
        })?;

        let now = now_timestamp();
        let mut count = 0;

        for att in &attachments {
            tx.execute(
                "INSERT OR REPLACE INTO attachments (id, message_id, filename, path, mime_type, uti, size, is_outgoing, created_at, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    att.id,
                    att.message_id,
                    att.filename,
                    att.path,
                    att.mime_type,
                    att.uti,
                    att.size,
                    att.is_outgoing as i32,
                    att.created_at,
                    now,
                ],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Insert attachment error: {}", e))
            })?;
            count += 1;
        }

        tx.commit().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Commit error: {}", e))
        })?;

        Ok(count)
    }

    // ============================================
    // QUERY METHODS (for API)
    // ============================================

    /// Get all chats with last message info, ordered by most recent.
    pub fn get_all_chats(&self) -> PyResult<Vec<PrmChat>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT
                    c.id, c.identifier, c.name, c.is_group,
                    (SELECT text FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_text,
                    (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_ts
                 FROM chats c
                 ORDER BY last_ts DESC NULLS LAST",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                Ok(PrmChat {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    is_group: row.get::<_, i32>(3)? != 0,
                    last_message_text: row.get(4)?,
                    last_message_timestamp: row.get(5)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get a chat by ID.
    pub fn get_chat(&self, chat_id: i64) -> PyResult<Option<PrmChat>> {
        let result = self.conn.query_row(
            "SELECT
                c.id, c.identifier, c.name, c.is_group,
                (SELECT text FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_text,
                (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_ts
             FROM chats c
             WHERE c.id = ?",
            [chat_id],
            |row| {
                Ok(PrmChat {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    is_group: row.get::<_, i32>(3)? != 0,
                    last_message_text: row.get(4)?,
                    last_message_timestamp: row.get(5)?,
                })
            },
        );
        match result {
            Ok(chat) => Ok(Some(chat)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                "Get chat error: {}",
                e
            ))),
        }
    }

    /// Get participants for a chat.
    pub fn get_chat_participants(&self, chat_id: i64) -> PyResult<Vec<Person>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT p.id, p.identifier, p.name, p.service, p.is_contact,
                        p.phones, p.emails, p.company, p.notes
                 FROM people p
                 INNER JOIN chat_participants cp ON cp.person_id = p.id
                 WHERE cp.chat_id = ?
                 ORDER BY p.name",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([chat_id], |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    service: row.get(3)?,
                    is_contact: row.get::<_, i32>(4)? != 0,
                    phones: row.get(5)?,
                    emails: row.get(6)?,
                    company: row.get(7)?,
                    notes: row.get(8)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get messages for a chat with sender name pre-joined.
    pub fn get_chat_messages(&self, chat_id: i64, limit: u32) -> PyResult<Vec<PrmMessage>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT m.id, m.chat_id, m.sender_id, p.name as sender_name, m.text, m.timestamp,
                        m.is_from_me, m.is_read, m.read_at, m.has_attachments
                 FROM messages m
                 LEFT JOIN people p ON p.id = m.sender_id
                 WHERE m.chat_id = ?
                 ORDER BY m.timestamp DESC
                 LIMIT ?",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map(params![chat_id, limit], |row| {
                Ok(PrmMessage {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_name: row.get(3)?,
                    text: row.get(4)?,
                    timestamp: row.get(5)?,
                    is_from_me: row.get::<_, i32>(6)? != 0,
                    is_read: row.get::<_, i32>(7)? != 0,
                    read_at: row.get(8)?,
                    has_attachments: row.get::<_, i32>(9)? != 0,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get attachments for a message.
    pub fn get_message_attachments(&self, message_id: i64) -> PyResult<Vec<Attachment>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, message_id, filename, path, mime_type, uti, size, is_outgoing, created_at
                 FROM attachments
                 WHERE message_id = ?",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([message_id], |row| {
                Ok(Attachment {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    filename: row.get(2)?,
                    path: row.get(3)?,
                    mime_type: row.get(4)?,
                    uti: row.get(5)?,
                    size: row.get(6)?,
                    is_outgoing: row.get::<_, i32>(7)? != 0,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get message count.
    pub fn message_count(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }

    /// Get people count.
    pub fn people_count(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM people", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }

    /// Get chat count.
    pub fn chat_count(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM chats", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }

    // ============================================
    // ACTIONS CRUD
    // ============================================

    /// Create a new action
    #[allow(clippy::too_many_arguments)]
    pub fn create_action(
        &self,
        action_type: &str,
        priority: i32,
        chat_id: Option<i64>,
        person_id: Option<i64>,
        message_id: Option<i64>,
        payload: Option<&str>,
        remind_at: Option<i64>,
    ) -> PyResult<i64> {
        let now = now_timestamp();
        self.conn.execute(
            "INSERT INTO actions (type, status, priority, chat_id, person_id, message_id, payload, created_at, remind_at)
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
            params![action_type, priority, chat_id, person_id, message_id, payload, now, remind_at],
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Create action error: {}", e)))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Get pending actions ordered by priority
    pub fn get_pending_actions(&self, limit: u32) -> PyResult<Vec<crate::models::Action>> {
        let mut stmt = self.conn.prepare(
            "SELECT a.id, a.type, a.status, a.priority, a.chat_id, a.person_id, a.message_id,
                    a.payload, a.created_at, a.remind_at, a.snoozed_until, a.completed_at, a.discarded_at,
                    c.name as chat_name, p.name as person_name, m.text as message_text, m.timestamp as message_timestamp
             FROM actions a
             LEFT JOIN chats c ON c.id = a.chat_id
             LEFT JOIN people p ON p.id = a.person_id
             LEFT JOIN messages m ON m.id = a.message_id
             WHERE a.status = 'pending'
             AND (a.snoozed_until IS NULL OR a.snoozed_until <= strftime('%s', 'now'))
             ORDER BY a.priority DESC, a.created_at ASC
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok(crate::models::Action {
                    id: row.get(0)?,
                    action_type: row.get(1)?,
                    status: row.get(2)?,
                    priority: row.get(3)?,
                    chat_id: row.get(4)?,
                    person_id: row.get(5)?,
                    message_id: row.get(6)?,
                    payload: row.get(7)?,
                    created_at: row.get(8)?,
                    remind_at: row.get(9)?,
                    snoozed_until: row.get(10)?,
                    completed_at: row.get(11)?,
                    discarded_at: row.get(12)?,
                    chat_name: row.get(13)?,
                    person_name: row.get(14)?,
                    message_text: row.get(15)?,
                    message_timestamp: row.get(16)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get action by ID
    pub fn get_action(&self, id: i64) -> PyResult<Option<crate::models::Action>> {
        let result = self.conn.query_row(
            "SELECT a.id, a.type, a.status, a.priority, a.chat_id, a.person_id, a.message_id,
                    a.payload, a.created_at, a.remind_at, a.snoozed_until, a.completed_at, a.discarded_at,
                    c.name as chat_name, p.name as person_name, m.text as message_text, m.timestamp as message_timestamp
             FROM actions a
             LEFT JOIN chats c ON c.id = a.chat_id
             LEFT JOIN people p ON p.id = a.person_id
             LEFT JOIN messages m ON m.id = a.message_id
             WHERE a.id = ?",
            [id],
            |row| {
                Ok(crate::models::Action {
                    id: row.get(0)?,
                    action_type: row.get(1)?,
                    status: row.get(2)?,
                    priority: row.get(3)?,
                    chat_id: row.get(4)?,
                    person_id: row.get(5)?,
                    message_id: row.get(6)?,
                    payload: row.get(7)?,
                    created_at: row.get(8)?,
                    remind_at: row.get(9)?,
                    snoozed_until: row.get(10)?,
                    completed_at: row.get(11)?,
                    discarded_at: row.get(12)?,
                    chat_name: row.get(13)?,
                    person_name: row.get(14)?,
                    message_text: row.get(15)?,
                    message_timestamp: row.get(16)?,
                })
            },
        );
        match result {
            Ok(action) => Ok(Some(action)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                "Get action error: {}",
                e
            ))),
        }
    }

    /// Update action status
    pub fn update_action_status(
        &self,
        id: i64,
        status: &str,
        snoozed_until: Option<i64>,
    ) -> PyResult<()> {
        let now = now_timestamp();
        let (completed_at, discarded_at) = match status {
            "completed" => (Some(now), None),
            "discarded" => (None, Some(now)),
            _ => (None, None),
        };
        self.conn.execute(
            "UPDATE actions SET status = ?, snoozed_until = ?, completed_at = ?, discarded_at = ? WHERE id = ?",
            params![status, snoozed_until, completed_at, discarded_at, id],
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Update action error: {}", e)))?;
        Ok(())
    }

    /// Delete action
    pub fn delete_action(&self, id: i64) -> PyResult<()> {
        self.conn
            .execute("DELETE FROM actions WHERE id = ?", [id])
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Delete action error: {}", e))
            })?;
        Ok(())
    }

    // ============================================
    // FTS SEARCH
    // ============================================

    /// Search messages using FTS5
    pub fn search_messages(
        &self,
        query: &str,
        limit: u32,
    ) -> PyResult<Vec<crate::models::SearchResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.chat_id, m.text, m.timestamp, p.name as sender_name, c.name as chat_name,
                    bm25(messages_fts) as rank
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             LEFT JOIN people p ON p.id = m.sender_id
             LEFT JOIN chats c ON c.id = m.chat_id
             WHERE messages_fts MATCH ?
             ORDER BY rank
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map(params![query, limit], |row| {
                Ok(crate::models::SearchResult {
                    message_id: row.get(0)?,
                    chat_id: row.get(1)?,
                    text: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    timestamp: row.get(3)?,
                    sender_name: row.get(4)?,
                    chat_name: row.get(5)?,
                    rank: row.get(6)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Rebuild FTS index from existing messages
    pub fn rebuild_fts_index(&self) -> PyResult<u32> {
        // Clear and rebuild
        self.conn
            .execute("DELETE FROM messages_fts", [])
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Clear FTS error: {}", e))
            })?;
        let count = self.conn.execute(
            "INSERT INTO messages_fts(rowid, text) SELECT id, text FROM messages WHERE text IS NOT NULL",
            []
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Rebuild FTS error: {}", e)))?;
        Ok(count as u32)
    }

    // ============================================
    // EOD DETECTION
    // ============================================

    /// Get today's new contacts (people texted today who aren't saved contacts)
    pub fn get_todays_new_contacts(&self) -> PyResult<Vec<Person>> {
        let today_start = chrono::Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT p.id, p.identifier, p.name, p.service, p.is_contact, p.phones, p.emails, p.company, p.notes
             FROM people p
             JOIN messages m ON (m.sender_id = p.id OR
                 (m.is_from_me = 1 AND m.chat_id IN (SELECT chat_id FROM chat_participants WHERE person_id = p.id)))
             WHERE m.timestamp >= ?
             AND p.is_contact = 0"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([today_start], |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    service: row.get(3)?,
                    is_contact: row.get::<_, i32>(4)? != 0,
                    phones: row.get(5)?,
                    emails: row.get(6)?,
                    company: row.get(7)?,
                    notes: row.get(8)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Check if person already has EOD action today
    pub fn has_eod_action_today(&self, person_id: i64) -> PyResult<bool> {
        let today_start = chrono::Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM actions WHERE person_id = ? AND type = 'eod_contact' AND created_at >= ?",
            params![person_id, today_start],
            |row| row.get(0)
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;
        Ok(count > 0)
    }

    // ============================================
    // UNANSWERED MESSAGE DETECTION
    // ============================================

    /// Get chats with unanswered messages older than threshold_hours.
    /// Only includes chats where:
    /// - Their last message is newer than my last message (I haven't replied)
    /// - Their last message is older than threshold (been waiting a while)
    /// - No pending/snoozed respond_to_message action already exists
    pub fn get_unanswered_chats(&self, threshold_hours: u32) -> PyResult<Vec<UnansweredChat>> {
        let threshold_secs = (threshold_hours as i64) * 3600;
        let now = now_timestamp();

        let mut stmt = self.conn.prepare(
            "WITH latest_messages AS (
                SELECT
                    chat_id,
                    MAX(CASE WHEN is_from_me = 1 THEN timestamp ELSE 0 END) as my_latest,
                    MAX(CASE WHEN is_from_me = 0 THEN timestamp ELSE 0 END) as their_latest
                FROM messages
                GROUP BY chat_id
            )
            SELECT
                m.id as message_id,
                m.chat_id,
                m.sender_id,
                m.text,
                m.timestamp,
                c.name as chat_name,
                p.name as person_name,
                (? - m.timestamp) / 3600 as hours_since
            FROM messages m
            JOIN latest_messages lm ON lm.chat_id = m.chat_id AND m.timestamp = lm.their_latest
            LEFT JOIN chats c ON c.id = m.chat_id
            LEFT JOIN people p ON p.id = m.sender_id
            WHERE lm.their_latest > lm.my_latest
            AND lm.their_latest < (? - ?)
            AND NOT EXISTS (
                SELECT 1 FROM actions
                WHERE chat_id = m.chat_id
                AND type = 'respond_to_message'
                AND status IN ('pending', 'snoozed')
            )
            ORDER BY m.timestamp DESC"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map(params![now, now, threshold_secs], |row| {
                Ok(UnansweredChat {
                    message_id: row.get(0)?,
                    chat_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    text: row.get(3)?,
                    timestamp: row.get(4)?,
                    chat_name: row.get(5)?,
                    person_name: row.get(6)?,
                    hours_since: row.get(7)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    // ============================================
    // EMBEDDING METHODS
    // ============================================

    /// Get messages pending embedding generation
    pub fn get_pending_embeddings(&self, limit: u32) -> PyResult<Vec<PendingEmbedding>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.chat_id, m.text
             FROM embedding_queue eq
             JOIN messages m ON m.id = eq.message_id
             WHERE eq.status = 'pending'
             AND m.text IS NOT NULL AND length(m.text) > 0
             ORDER BY eq.queued_at ASC
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok(PendingEmbedding {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    text: row.get(2)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Queue a message for embedding generation
    pub fn queue_for_embedding(&self, message_id: i64) -> PyResult<()> {
        let now = now_timestamp();
        self.conn.execute(
            "INSERT OR IGNORE INTO embedding_queue (message_id, queued_at, status) VALUES (?, ?, 'pending')",
            params![message_id, now]
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Queue error: {}", e)))?;
        Ok(())
    }

    /// Insert a message embedding
    pub fn insert_embedding(&self, message_id: i64, chat_id: i64, embedding: Vec<u8>) -> PyResult<()> {
        let now = now_timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO message_embeddings (message_id, chat_id, embedding, created_at)
             VALUES (?, ?, ?, ?)",
            params![message_id, chat_id, embedding, now]
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Insert embedding error: {}", e)))?;
        Ok(())
    }

    /// Mark embedding as complete in queue
    pub fn mark_embedding_complete(&self, message_id: i64) -> PyResult<()> {
        self.conn.execute(
            "UPDATE embedding_queue SET status = 'completed' WHERE message_id = ?",
            [message_id]
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Update error: {}", e)))?;
        Ok(())
    }

    /// Get all embeddings for semantic search
    pub fn get_all_embeddings(&self) -> PyResult<Vec<StoredEmbedding>> {
        let mut stmt = self.conn.prepare(
            "SELECT message_id, chat_id, embedding FROM message_embeddings"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(StoredEmbedding {
                    message_id: row.get(0)?,
                    chat_id: row.get(1)?,
                    embedding: row.get(2)?,
                })
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get message text by ID (for search results)
    pub fn get_message_text(&self, message_id: i64) -> PyResult<Option<String>> {
        let result = self.conn.query_row(
            "SELECT text FROM messages WHERE id = ?",
            [message_id],
            |row| row.get(0)
        );
        match result {
            Ok(text) => Ok(text),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))
        }
    }

    /// Queue all existing messages for embedding (one-time setup)
    pub fn queue_all_messages_for_embedding(&self) -> PyResult<u32> {
        let now = now_timestamp();
        let count = self.conn.execute(
            "INSERT OR IGNORE INTO embedding_queue (message_id, queued_at, status)
             SELECT id, ?, 'pending' FROM messages WHERE text IS NOT NULL AND length(text) > 0",
            [now]
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Queue error: {}", e)))?;
        Ok(count as u32)
    }

    /// Get embedding queue stats
    pub fn get_embedding_queue_stats(&self) -> PyResult<(i64, i64, i64)> {
        let pending: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM embedding_queue WHERE status = 'pending'",
            [],
            |row| row.get(0)
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let completed: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM embedding_queue WHERE status = 'completed'",
            [],
            |row| row.get(0)
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let total_embeddings: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM message_embeddings",
            [],
            |row| row.get(0)
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        Ok((pending, completed, total_embeddings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> AppDb {
        let db = AppDb::open_in_memory();
        // Create schema directly since init_schema returns PyResult
        db.conn
            .execute_batch(
                "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS people (
                id INTEGER PRIMARY KEY,
                identifier TEXT NOT NULL,
                name TEXT NOT NULL,
                service TEXT NOT NULL,
                is_contact INTEGER NOT NULL DEFAULT 0,
                phones TEXT,
                emails TEXT,
                company TEXT,
                notes TEXT,
                synced_at INTEGER NOT NULL,
                UNIQUE(identifier, service)
            );
            CREATE INDEX IF NOT EXISTS idx_people_identifier ON people(identifier);
            CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);

            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY,
                identifier TEXT NOT NULL,
                name TEXT,
                is_group INTEGER NOT NULL,
                synced_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                person_id INTEGER NOT NULL REFERENCES people(id),
                PRIMARY KEY (chat_id, person_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                sender_id INTEGER REFERENCES people(id),
                text TEXT,
                timestamp INTEGER NOT NULL,
                is_from_me INTEGER NOT NULL,
                is_read INTEGER NOT NULL,
                read_at INTEGER,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                synced_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);

            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_message_rowid', 0);
            INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_attachment_rowid', 0);
            ",
            )
            .unwrap();
        db
    }

    #[test]
    fn test_insert_single_person() {
        let db = create_test_db();
        let now = now_timestamp();
        let emails_json = serde_json::to_string(&vec!["alice@example.com"]).unwrap();
        let phones_json = serde_json::to_string(&vec!["+12025551234"]).unwrap();

        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, phones, emails, company, notes, synced_at)
                 VALUES (1, '+12025551234', 'Alice Smith', 'iMessage', 1, ?1, ?2, 'Acme Corp', 'Met at conference', ?3)",
                params![phones_json, emails_json, now],
            )
            .unwrap();

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM people", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify the inserted data
        let (name, company): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT name, company FROM people WHERE identifier = ?",
                ["+12025551234"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Alice Smith");
        assert_eq!(company, Some("Acme Corp".to_string()));
    }

    #[test]
    fn test_upsert_updates_existing_person() {
        let db = create_test_db();
        let now = now_timestamp();

        // Insert initial person
        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, company, synced_at)
                 VALUES (1, '+12025551234', 'Bob Jones', 'iMessage', 1, 'Old Corp', ?1)",
                [now],
            )
            .unwrap();

        // Upsert with same id but different data
        db.conn
            .execute(
                "INSERT OR REPLACE INTO people (id, identifier, name, service, is_contact, company, notes, synced_at)
                 VALUES (1, '+12025551234', 'Bob Jones', 'iMessage', 1, 'New Corp', 'Updated', ?1)",
                [now],
            )
            .unwrap();

        // Should still be 1 person
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM people", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify the data was updated
        let (company, notes): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT company, notes FROM people WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(company, Some("New Corp".to_string()));
        assert_eq!(notes, Some("Updated".to_string()));
    }

    #[test]
    fn test_get_people_ordered_by_name() {
        let db = create_test_db();
        let now = now_timestamp();

        // Insert people out of alphabetical order
        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, synced_at)
                 VALUES (1, '+12025551111', 'Zara', 'iMessage', 0, ?1)",
                [now],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, synced_at)
                 VALUES (2, '+12025552222', 'Alice', 'iMessage', 1, ?1)",
                [now],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, synced_at)
                 VALUES (3, '+12025553333', 'Mike', 'iMessage', 1, ?1)",
                [now],
            )
            .unwrap();

        // Query people ordered by name
        let mut stmt = db
            .conn
            .prepare("SELECT id, identifier, name, service, is_contact, phones, emails, company, notes FROM people ORDER BY name")
            .unwrap();
        let people: Vec<Person> = stmt
            .query_map([], |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    service: row.get(3)?,
                    is_contact: row.get::<_, i32>(4)? != 0,
                    phones: row.get(5)?,
                    emails: row.get(6)?,
                    company: row.get(7)?,
                    notes: row.get(8)?,
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(people.len(), 3);
        assert_eq!(people[0].name, "Alice");
        assert_eq!(people[1].name, "Mike");
        assert_eq!(people[2].name, "Zara");
    }

    #[test]
    fn test_person_with_multiple_emails_and_phones() {
        let db = create_test_db();
        let now = now_timestamp();

        let emails = vec!["alice@work.com", "alice@personal.com"];
        let phones = vec!["+12025551234", "+12025555678"];
        let emails_json = serde_json::to_string(&emails).unwrap();
        let phones_json = serde_json::to_string(&phones).unwrap();

        db.conn
            .execute(
                "INSERT INTO people (id, identifier, name, service, is_contact, phones, emails, synced_at)
                 VALUES (1, '+12025551234', 'Alice', 'iMessage', 1, ?1, ?2, ?3)",
                params![phones_json, emails_json, now],
            )
            .unwrap();

        let (stored_phones, stored_emails): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT phones, emails FROM people WHERE name = 'Alice'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        // Verify JSON arrays are stored correctly
        let parsed_phones: Vec<String> = serde_json::from_str(&stored_phones.unwrap()).unwrap();
        let parsed_emails: Vec<String> = serde_json::from_str(&stored_emails.unwrap()).unwrap();

        assert_eq!(parsed_emails.len(), 2);
        assert_eq!(parsed_phones.len(), 2);
        assert!(parsed_emails.contains(&"alice@work.com".to_string()));
        assert!(parsed_phones.contains(&"+12025551234".to_string()));
    }
}
