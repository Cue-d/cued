//! Dumb data reader for iMessage chat.db.

use pyo3::prelude::*;
use rusqlite::{Connection, OpenFlags};

use crate::models::Message;

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
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Failed to open chat.db: {}", e)))?;
        Ok(Self { conn })
    }

    /// Count total messages.
    pub fn count_messages(&self) -> PyResult<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }

    /// Get recent messages.
    pub fn get_recent_messages(&self, limit: u32) -> PyResult<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT ROWID, text, date, is_from_me, attributedBody
             FROM message
             ORDER BY date DESC
             LIMIT ?"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt.query_map([limit], |row| {
            let text: Option<String> = row.get(1)?;
            let attributed_body: Option<Vec<u8>> = row.get(4)?;

            let final_text = match text {
                Some(t) => Some(t),
                None => attributed_body.and_then(|blob| extract_text_from_attributed_body(&blob)),
            };

            Ok(Message {
                rowid: row.get(0)?,
                text: final_text,
                date: row.get(2)?,
                is_from_me: row.get(3)?,
            })
        }).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e)))?);
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
                        let filtered: String = trimmed.chars()
                            .filter(|&c| c != '\u{FFFC}')
                            .collect();
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
