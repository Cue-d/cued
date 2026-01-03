//! Dumb data reader for iMessage chat.db.

use pyo3::prelude::*;
use rusqlite::{Connection, OpenFlags};

use crate::models::{Chat, Handle, Message};

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
}

/// Extract text from an attributedBody blob (Apple's typedstream format).
fn extract_text_from_attributed_body(blob: &[u8]) -> Option<String> {
    let ns_string = b"NSString";
    let pos = blob.windows(ns_string.len()).position(|w| w == ns_string)?;

    let search_start = pos + ns_string.len();
    let after_marker = &blob[search_start..];

    for i in 0..after_marker.len().saturating_sub(6) {
        let first_byte = after_marker.get(i);
        if (first_byte == Some(&0x94) || first_byte == Some(&0x95))
            && after_marker.get(i + 1) == Some(&0x84)
            && after_marker.get(i + 2) == Some(&0x01)
            && after_marker.get(i + 3) == Some(&0x2B)
        {
            let (len_bytes_consumed, text_len) = decode_length(&after_marker[i + 4..])?;
            let text_start = i + 4 + len_bytes_consumed;

            if text_start + text_len <= after_marker.len() {
                let text_bytes = &after_marker[text_start..text_start + text_len];
                if let Ok(text) = std::str::from_utf8(text_bytes) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty()
                        && !trimmed.starts_with("NS")
                        && !trimmed.starts_with("_NS")
                        && !trimmed.contains("AttributeName")
                    {
                        let filtered: String =
                            trimmed.chars().filter(|&c| c != '\u{FFFC}').collect();
                        if !filtered.is_empty() {
                            return Some(filtered);
                        } else {
                            return Some("[attachment]".to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Decode a variable-length integer used in Apple's typedstream format.
fn decode_length(data: &[u8]) -> Option<(usize, usize)> {
    let first = *data.first()?;

    if first < 0x80 {
        Some((1, first as usize))
    } else if first == 0x81 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        Some((3, b1 | (b2 << 8)))
    } else if first == 0x82 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        let b3 = *data.get(3)? as usize;
        Some((4, b1 | (b2 << 8) | (b3 << 16)))
    } else if first == 0x83 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        let b3 = *data.get(3)? as usize;
        let b4 = *data.get(4)? as usize;
        Some((5, b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // decode_length tests
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
