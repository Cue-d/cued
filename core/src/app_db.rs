//! Dumb data store for prm.db (app's SQLite database).

use pyo3::prelude::*;
use rusqlite::{Connection, params};

use crate::models::{
    Attachment, Person, PrmChat, PrmMessage, SyncAttachment, SyncChat, SyncMessage,
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
                short_name TEXT,
                service TEXT NOT NULL,
                is_contact INTEGER NOT NULL DEFAULT 0,
                contact_phones TEXT,
                contact_emails TEXT,
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
                display_name TEXT,
                computed_name TEXT,
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
            ",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Schema error: {}", e))
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
        short_name: Option<&str>,
        service: &str,
        is_contact: bool,
        contact_phones: Option<&str>,
        contact_emails: Option<&str>,
        company: Option<&str>,
        notes: Option<&str>,
    ) -> PyResult<()> {
        let now = now_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO people
                 (id, identifier, name, short_name, service, is_contact, contact_phones, contact_emails, company, notes, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    identifier,
                    name,
                    short_name,
                    service,
                    is_contact as i32,
                    contact_phones,
                    contact_emails,
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
            "SELECT id, identifier, name, short_name, service, is_contact, contact_phones, contact_emails, company, notes
             FROM people WHERE id = ?",
            [id],
            |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    short_name: row.get(3)?,
                    service: row.get(4)?,
                    is_contact: row.get::<_, i32>(5)? != 0,
                    contact_phones: row.get(6)?,
                    contact_emails: row.get(7)?,
                    company: row.get(8)?,
                    notes: row.get(9)?,
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
    pub fn upsert_chat(&self, chat: &SyncChat, computed_name: &str) -> PyResult<()> {
        let now = now_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO chats (id, identifier, display_name, computed_name, is_group, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    chat.id,
                    chat.identifier,
                    chat.display_name,
                    computed_name,
                    chat.is_group as i32,
                    now,
                ],
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Upsert chat error: {}", e))
            })?;
        Ok(())
    }

    /// Bulk replace all chat participants.
    /// Takes a list of (chat_id, handle_id) tuples - handle_id is used as person_id.
    pub fn replace_chat_participants(&mut self, participants: Vec<(i64, i64)>) -> PyResult<()> {
        let tx = self.conn.transaction().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e))
        })?;

        // Delete all existing participants
        tx.execute("DELETE FROM chat_participants", [])
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Delete participants error: {}",
                    e
                ))
            })?;

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
                    c.id, c.identifier, c.display_name, c.computed_name, c.is_group,
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
                    display_name: row.get(2)?,
                    computed_name: row.get(3)?,
                    is_group: row.get::<_, i32>(4)? != 0,
                    last_message_text: row.get(5)?,
                    last_message_timestamp: row.get(6)?,
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
                c.id, c.identifier, c.display_name, c.computed_name, c.is_group,
                (SELECT text FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_text,
                (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_ts
             FROM chats c
             WHERE c.id = ?",
            [chat_id],
            |row| {
                Ok(PrmChat {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    display_name: row.get(2)?,
                    computed_name: row.get(3)?,
                    is_group: row.get::<_, i32>(4)? != 0,
                    last_message_text: row.get(5)?,
                    last_message_timestamp: row.get(6)?,
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
                "SELECT p.id, p.identifier, p.name, p.short_name, p.service, p.is_contact,
                        p.contact_phones, p.contact_emails, p.company, p.notes
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
                    short_name: row.get(3)?,
                    service: row.get(4)?,
                    is_contact: row.get::<_, i32>(5)? != 0,
                    contact_phones: row.get(6)?,
                    contact_emails: row.get(7)?,
                    company: row.get(8)?,
                    notes: row.get(9)?,
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
                short_name TEXT,
                service TEXT NOT NULL,
                is_contact INTEGER NOT NULL DEFAULT 0,
                contact_phones TEXT,
                contact_emails TEXT,
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
                display_name TEXT,
                computed_name TEXT,
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
                "INSERT INTO people (id, identifier, name, short_name, service, is_contact, contact_phones, contact_emails, company, notes, synced_at)
                 VALUES (1, '+12025551234', 'Alice Smith', 'Alice', 'iMessage', 1, ?1, ?2, 'Acme Corp', 'Met at conference', ?3)",
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
                "INSERT INTO people (id, identifier, name, short_name, service, is_contact, company, synced_at)
                 VALUES (1, '+12025551234', 'Bob Jones', 'Bob', 'iMessage', 1, 'Old Corp', ?1)",
                [now],
            )
            .unwrap();

        // Upsert with same id but different data
        db.conn
            .execute(
                "INSERT OR REPLACE INTO people (id, identifier, name, short_name, service, is_contact, company, notes, synced_at)
                 VALUES (1, '+12025551234', 'Bob Jones', 'Bob', 'iMessage', 1, 'New Corp', 'Updated', ?1)",
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
            .prepare("SELECT id, identifier, name, short_name, service, is_contact, contact_phones, contact_emails, company, notes FROM people ORDER BY name")
            .unwrap();
        let people: Vec<Person> = stmt
            .query_map([], |row| {
                Ok(Person {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    name: row.get(2)?,
                    short_name: row.get(3)?,
                    service: row.get(4)?,
                    is_contact: row.get::<_, i32>(5)? != 0,
                    contact_phones: row.get(6)?,
                    contact_emails: row.get(7)?,
                    company: row.get(8)?,
                    notes: row.get(9)?,
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
                "INSERT INTO people (id, identifier, name, service, is_contact, contact_phones, contact_emails, synced_at)
                 VALUES (1, '+12025551234', 'Alice', 'iMessage', 1, ?1, ?2, ?3)",
                params![phones_json, emails_json, now],
            )
            .unwrap();

        let (stored_phones, stored_emails): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT contact_phones, contact_emails FROM people WHERE name = 'Alice'",
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
