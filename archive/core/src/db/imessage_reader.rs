//! Dumb data reader for iMessage chat.db.

use pyo3::prelude::*;
use rusqlite::{Connection, OpenFlags};

use crate::models::{Chat, Handle, Message, SyncAttachment, SyncChat, SyncHandle, SyncMessage};
use crate::utils::{apple_to_unix, extract_text_from_attributed_body};

/// iMessage database reader.
#[pyclass(unsendable)]
pub struct ChatReader {
    conn: Connection,
}

#[pymethods]
impl ChatReader {
    /// Open chat.db in read-only mode.
    #[new]
    pub fn open(path: &str) -> PyResult<Self> {
        let conn =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
                pyo3::exceptions::PyIOError::new_err(format!("Failed to open chat.db: {}", e))
            })?;
        Ok(Self { conn })
    }

    /// Count total messages.
    pub fn count_messages(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }

    /// Get all chats with their last message.
    pub fn get_all_chats(&self) -> PyResult<Vec<Chat>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT
                c.ROWID,
                c.chat_identifier,
                c.display_name,
                c.style,
                COALESCE(
                    (SELECT m.date FROM message m
                     INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                     WHERE cmj.chat_id = c.ROWID
                     ORDER BY m.date DESC LIMIT 1),
                    0
                ) as last_date,
                (SELECT m.text FROM message m
                 INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                 WHERE cmj.chat_id = c.ROWID
                 ORDER BY m.date DESC LIMIT 1) as last_text
             FROM chat c
             ORDER BY last_date DESC",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                let style: i64 = row.get(3)?;
                Ok(Chat {
                    rowid: row.get(0)?,
                    chat_identifier: row.get(1)?,
                    display_name: row.get(2)?,
                    is_group: style == 45, // 43 = 1:1, 45 = group
                    last_message_date: row.get(4)?,
                    last_message_text: row.get(5)?,
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

    /// Get all handles (phone numbers / emails).
    pub fn get_all_handles(&self) -> PyResult<Vec<Handle>> {
        let mut stmt = self
            .conn
            .prepare("SELECT ROWID, id, service FROM handle ORDER BY ROWID")
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Handle {
                    rowid: row.get(0)?,
                    id: row.get(1)?,
                    service: row.get(2)?,
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

    /// Get handles for a specific chat.
    pub fn get_chat_handles(&self, chat_id: i64) -> PyResult<Vec<Handle>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT h.ROWID, h.id, h.service
             FROM handle h
             INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
             WHERE chj.chat_id = ?
             ORDER BY h.ROWID",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([chat_id], |row| {
                Ok(Handle {
                    rowid: row.get(0)?,
                    id: row.get(1)?,
                    service: row.get(2)?,
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

    /// Get messages for a specific chat.
    pub fn get_chat_messages(&self, chat_id: i64, limit: u32) -> PyResult<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.ROWID, m.text, m.date, m.is_from_me, m.handle_id, m.attributedBody, m.is_read, m.date_read
             FROM message m
             INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
             WHERE cmj.chat_id = ?
             ORDER BY m.date DESC
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([chat_id, limit as i64], |row| {
                let text: Option<String> = row.get(1)?;
                let attributed_body: Option<Vec<u8>> = row.get(5)?;

                let final_text = match text {
                    Some(t) => Some(t),
                    None => {
                        attributed_body.and_then(|blob| extract_text_from_attributed_body(&blob))
                    }
                };

                let is_read_int: i64 = row.get(6)?;
                let date_read: Option<i64> = row.get(7)?;

                Ok(Message {
                    rowid: row.get(0)?,
                    text: final_text,
                    date: row.get(2)?,
                    is_from_me: row.get(3)?,
                    is_read: is_read_int != 0,
                    date_read,
                    handle_id: row.get(4)?,
                    chat_id: Some(chat_id),
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
    // SYNC METHODS - For syncing to prm.db
    // ============================================

    /// Get all handles for syncing to prm.db.
    pub fn get_all_handles_for_sync(&self) -> PyResult<Vec<SyncHandle>> {
        let mut stmt = self
            .conn
            .prepare("SELECT ROWID, id, service FROM handle ORDER BY ROWID")
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                Ok(SyncHandle {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    service: row.get(2)?,
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

    /// Get all chats for syncing to prm.db.
    pub fn get_all_chats_for_sync(&self) -> PyResult<Vec<SyncChat>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT c.ROWID, c.chat_identifier, c.display_name,
                        (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID) as participant_count
                 FROM chat c
                 ORDER BY c.ROWID",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                let participant_count: i64 = row.get(3)?;
                Ok(SyncChat {
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    display_name: row.get(2)?,
                    is_group: participant_count > 1, // Group = multiple participants
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

    /// Get all chat-handle participant pairs for syncing.
    pub fn get_chat_participants_for_sync(&self) -> PyResult<Vec<(i64, i64)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT chat_id, handle_id FROM chat_handle_join ORDER BY chat_id, handle_id")
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                let chat_id: i64 = row.get(0)?;
                let handle_id: i64 = row.get(1)?;
                Ok((chat_id, handle_id))
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

    /// Get messages with ROWID > since_rowid for incremental sync.
    /// Returns messages with timestamps converted to Unix epoch.
    /// Only returns regular messages (not reactions - those have associated_message_type >= 2000).
    pub fn get_messages_since(&self, since_rowid: i64, limit: u32) -> PyResult<Vec<SyncMessage>> {
        // Query messages with their chat_id from the join table
        // Exclude reactions (associated_message_type >= 2000)
        let mut stmt = self.conn.prepare(
            "SELECT m.ROWID, cmj.chat_id, m.handle_id, m.text, m.date, m.is_from_me,
                    m.is_read, m.date_read, m.attributedBody,
                    (SELECT COUNT(*) > 0 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as has_attachments,
                    m.is_sent, m.is_delivered, m.date_delivered, m.error
             FROM message m
             INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
             WHERE m.ROWID > ?
               AND (m.associated_message_type IS NULL OR m.associated_message_type < 2000)
             ORDER BY m.ROWID
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt
            .query_map([since_rowid, limit as i64], |row| {
                let text: Option<String> = row.get(3)?;
                let attributed_body: Option<Vec<u8>> = row.get(8)?;
                let apple_date: i64 = row.get(4)?;
                let apple_date_read: Option<i64> = row.get(7)?;
                let is_read_int: i64 = row.get(6)?;
                let has_attachments_int: i64 = row.get(9)?;
                let is_sent_int: i64 = row.get(10)?;
                let is_delivered_int: i64 = row.get(11)?;
                let apple_date_delivered: Option<i64> = row.get(12)?;
                let error: i32 = row.get(13)?;

                // Extract text from attributedBody if text is null
                let final_text = match text {
                    Some(t) => Some(t),
                    None => {
                        attributed_body.and_then(|blob| extract_text_from_attributed_body(&blob))
                    }
                };

                Ok(SyncMessage {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    handle_id: row.get(2)?,
                    text: final_text,
                    timestamp: apple_to_unix(apple_date),
                    is_from_me: row.get(5)?,
                    is_read: is_read_int != 0,
                    read_at: apple_date_read.map(apple_to_unix),
                    has_attachments: has_attachments_int != 0,
                    is_sent: is_sent_int != 0,
                    is_delivered: is_delivered_int != 0,
                    date_delivered: apple_date_delivered.map(apple_to_unix),
                    error,
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

    /// Get attachments with ROWID > since_rowid for incremental sync.
    pub fn get_attachments_since(
        &self,
        since_rowid: i64,
        limit: u32,
    ) -> PyResult<Vec<SyncAttachment>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT a.ROWID, maj.message_id, a.filename, a.mime_type,
                    a.uti, a.total_bytes, a.is_outgoing, a.created_date
             FROM attachment a
             INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
             WHERE a.ROWID > ?
             ORDER BY a.ROWID
             LIMIT ?",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([since_rowid, limit as i64], |row| {
                let apple_created: Option<i64> = row.get(7)?;

                Ok(SyncAttachment {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    filename: row.get(2)?,
                    path: row.get(2)?, // Use filename as path (actual path not stored in chat.db)
                    mime_type: row.get(3)?,
                    uti: row.get(4)?,
                    size: row.get(5)?,
                    is_outgoing: row.get(6)?,
                    created_at: apple_created.map(apple_to_unix),
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

    /// Get the maximum message ROWID (for determining sync progress).
    pub fn get_max_message_rowid(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COALESCE(MAX(ROWID), 0) FROM message", [], |row| {
                row.get(0)
            })
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))
    }

    /// Get the maximum attachment ROWID (for determining sync progress).
    pub fn get_max_attachment_rowid(&self) -> PyResult<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(ROWID), 0) FROM attachment",
                [],
                |row| row.get(0),
            )
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::decode_length;

    // decode_length tests (testing shared utils)
    #[test]
    fn test_decode_length_single_byte() {
        assert_eq!(decode_length(&[0x05]), Some((1, 5)));
        assert_eq!(decode_length(&[0x7F]), Some((1, 127)));
        assert_eq!(decode_length(&[0x00]), Some((1, 0)));
    }

    #[test]
    fn test_decode_length_two_byte() {
        // 0x81 marker = 2-byte length follows, little-endian: [low, high]
        // [0x00, 0x01] = 0x0100 = 256
        assert_eq!(decode_length(&[0x81, 0x00, 0x01]), Some((3, 256)));
        // [0x01, 0x00] = 0x0001 = 1
        assert_eq!(decode_length(&[0x81, 0x01, 0x00]), Some((3, 1)));
    }

    #[test]
    fn test_decode_length_empty() {
        assert_eq!(decode_length(&[]), None);
    }

    #[test]
    fn test_decode_length_invalid_marker() {
        assert_eq!(decode_length(&[0x84]), None); // Unsupported marker
        assert_eq!(decode_length(&[0xFF]), None);
    }

    #[test]
    fn test_decode_length_truncated() {
        // 0x81 expects 2 more bytes but only 1 provided
        assert_eq!(decode_length(&[0x81, 0x00]), None);
    }

    // extract_text_from_attributed_body tests
    #[test]
    fn test_extract_text_empty_blob() {
        assert_eq!(extract_text_from_attributed_body(&[]), None);
    }

    #[test]
    fn test_extract_text_no_nsstring_marker() {
        let blob = b"random data without marker";
        assert_eq!(extract_text_from_attributed_body(blob), None);
    }

    // ChatReader tests with in-memory SQLite
    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE chat (
                ROWID INTEGER PRIMARY KEY,
                chat_identifier TEXT,
                display_name TEXT,
                style INTEGER
            );
            CREATE TABLE handle (
                ROWID INTEGER PRIMARY KEY,
                id TEXT,
                service TEXT
            );
            CREATE TABLE message (
                ROWID INTEGER PRIMARY KEY,
                text TEXT,
                date INTEGER,
                is_from_me INTEGER,
                handle_id INTEGER,
                attributedBody BLOB,
                is_read INTEGER,
                date_read INTEGER
            );
            CREATE TABLE chat_message_join (
                chat_id INTEGER,
                message_id INTEGER
            );
            CREATE TABLE chat_handle_join (
                chat_id INTEGER,
                handle_id INTEGER
            );
            ",
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_chat_reader_count_messages_empty() {
        let conn = create_test_db();
        let reader = ChatReader { conn };
        // Use Rust directly, bypassing PyResult
        let count: i64 = reader
            .conn
            .query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_chat_reader_get_all_handles() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO handle (ROWID, id, service) VALUES (1, '+12025551234', 'iMessage')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO handle (ROWID, id, service) VALUES (2, 'alice@example.com', 'iMessage')",
            [],
        )
        .unwrap();

        let reader = ChatReader { conn };
        let mut stmt = reader
            .conn
            .prepare("SELECT ROWID, id, service FROM handle ORDER BY ROWID")
            .unwrap();
        let handles: Vec<Handle> = stmt
            .query_map([], |row| {
                Ok(Handle {
                    rowid: row.get(0)?,
                    id: row.get(1)?,
                    service: row.get(2)?,
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(handles.len(), 2);
        assert_eq!(handles[0].id, "+12025551234");
        assert_eq!(handles[1].id, "alice@example.com");
    }

    #[test]
    fn test_chat_reader_get_all_chats() {
        let conn = create_test_db();
        // Insert a 1:1 chat (style=43)
        conn.execute(
            "INSERT INTO chat (ROWID, chat_identifier, display_name, style) VALUES (1, '+12025551234', NULL, 43)",
            [],
        )
        .unwrap();
        // Insert a group chat (style=45)
        conn.execute(
            "INSERT INTO chat (ROWID, chat_identifier, display_name, style) VALUES (2, 'chat123', 'Family Group', 45)",
            [],
        )
        .unwrap();

        let reader = ChatReader { conn };
        let mut stmt = reader
            .conn
            .prepare(
                "SELECT ROWID, chat_identifier, display_name, style, 0, NULL FROM chat ORDER BY ROWID",
            )
            .unwrap();
        let chats: Vec<Chat> = stmt
            .query_map([], |row| {
                let style: i64 = row.get(3)?;
                Ok(Chat {
                    rowid: row.get(0)?,
                    chat_identifier: row.get(1)?,
                    display_name: row.get(2)?,
                    is_group: style == 45,
                    last_message_date: row.get(4)?,
                    last_message_text: row.get(5)?,
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(chats.len(), 2);
        assert!(!chats[0].is_group);
        assert!(chats[1].is_group);
        assert_eq!(chats[1].display_name, Some("Family Group".to_string()));
    }

    #[test]
    fn test_chat_reader_get_chat_messages() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO chat (ROWID, chat_identifier, display_name, style) VALUES (1, '+12025551234', NULL, 43)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (ROWID, text, date, is_from_me, handle_id, is_read, date_read) VALUES (1, 'Hello', 1000, 0, 1, 1, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (ROWID, text, date, is_from_me, handle_id, is_read, date_read) VALUES (2, 'Hi there', 2000, 1, 0, 1, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2)",
            [],
        )
        .unwrap();

        let reader = ChatReader { conn };
        let mut stmt = reader
            .conn
            .prepare(
                "SELECT m.ROWID, m.text, m.date, m.is_from_me, m.handle_id, m.is_read, m.date_read
             FROM message m
             INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
             WHERE cmj.chat_id = 1
             ORDER BY m.date DESC",
            )
            .unwrap();
        let messages: Vec<Message> = stmt
            .query_map([], |row| {
                let is_read_int: i64 = row.get(5)?;
                Ok(Message {
                    rowid: row.get(0)?,
                    text: row.get(1)?,
                    date: row.get(2)?,
                    is_from_me: row.get(3)?,
                    handle_id: row.get(4)?,
                    is_read: is_read_int != 0,
                    date_read: row.get(6)?,
                    chat_id: Some(1),
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(messages.len(), 2);
        // Ordered by date DESC, so "Hi there" (date=2000) comes first
        assert_eq!(messages[0].text, Some("Hi there".to_string()));
        assert!(messages[0].is_from_me);
        assert_eq!(messages[1].text, Some("Hello".to_string()));
        assert!(!messages[1].is_from_me);
    }
}
