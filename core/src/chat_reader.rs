use rusqlite::{Connection, OpenFlags, Result};

use crate::models::Message;

pub struct ChatReader {
    conn: Connection,
}

impl ChatReader {
    pub fn open(path: &str) -> Result<Self> {
        // Open the database in read-only mode
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(Self { conn })
    }

    pub fn count_messages(&self) -> Result<i64> {
        // Run a SQL query to count the number of messages in the database
        self.conn
            .query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0))
    }

    pub fn get_recent_messages(&self, limit: u32) -> Result<Vec<Message>> {
        // Query recent messages - using explicit column names for safety
        // Also fetch attributedBody for when text is NULL (modern macOS)
        let mut stmt = self.conn.prepare(
            "SELECT ROWID, text, date, is_from_me, attributedBody 
             FROM message 
             ORDER BY date DESC 
             LIMIT ?",
        )?;

        let message_iter = stmt.query_map([limit], |row| {
            let text: Option<String> = row.get(1)?;
            let attributed_body: Option<Vec<u8>> = row.get(4)?;

            // Try to get text from attributedBody if text is NULL
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
        })?;

        // Collect results, propagating any errors
        let mut messages = Vec::new();
        for message in message_iter {
            messages.push(message?);
        }
        Ok(messages)
    }
}

/// Extract text from an attributedBody blob (Apple's typedstream format).
///
/// The blob is an NSKeyedArchiver-encoded NSAttributedString. The text content
/// is stored as a length-prefixed string after specific marker bytes.
///
/// Format: ...NSString...\x94\x84\x01\x2B{len}{text}...
/// Where 0x2B ('+') is part of the marker, followed by length byte(s), then text.
fn extract_text_from_attributed_body(blob: &[u8]) -> Option<String> {
    // Find "NSString" marker - the text follows after some control bytes
    let ns_string = b"NSString";
    let pos = blob.windows(ns_string.len()).position(|w| w == ns_string)?;

    let search_start = pos + ns_string.len();
    let after_marker = &blob[search_start..];

    // Search for the marker sequence: 0x9X 0x84 0x01 0x2B followed by length and text
    // 0x9X can be 0x94 or 0x95 depending on string type (NSString vs NSMutableString)
    // The 0x2B ('+') is part of the marker, NOT the length!
    for i in 0..after_marker.len().saturating_sub(6) {
        let first_byte = after_marker.get(i);
        if (first_byte == Some(&0x94) || first_byte == Some(&0x95))
            && after_marker.get(i + 1) == Some(&0x84)
            && after_marker.get(i + 2) == Some(&0x01)
            && after_marker.get(i + 3) == Some(&0x2B) // '+' marker
        {
            // Length byte(s) start at i + 4
            let (len_bytes_consumed, text_len) = decode_length(&after_marker[i + 4..])?;
            let text_start = i + 4 + len_bytes_consumed;

                if text_start + text_len <= after_marker.len() {
                let text_bytes = &after_marker[text_start..text_start + text_len];
                if let Ok(text) = std::str::from_utf8(text_bytes) {
                    let trimmed = text.trim();
                    // Validate it looks like actual message content (not internal markers)
                    if !trimmed.is_empty()
                        && !trimmed.starts_with("NS")
                        && !trimmed.starts_with("_NS")
                        && !trimmed.contains("AttributeName")
                    {
                        // Filter out attachment placeholder (U+FFFC) only messages
                        let filtered: String = trimmed.chars()
                            .filter(|&c| c != '\u{FFFC}')
                            .collect();
                        if !filtered.is_empty() {
                            return Some(filtered);
                        } else {
                            // Message is just attachment placeholder(s)
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
/// Returns (bytes_consumed, value).
fn decode_length(data: &[u8]) -> Option<(usize, usize)> {
    let first = *data.first()?;

    if first < 0x80 {
        // Single byte length (0-127)
        Some((1, first as usize))
    } else if first == 0x81 {
        // Three bytes: 0x81 followed by 2-byte LITTLE-ENDIAN length
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        Some((3, b1 | (b2 << 8))) // Little-endian: low byte first
    } else if first == 0x82 {
        // Four bytes: 0x82 followed by 3-byte little-endian length
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        let b3 = *data.get(3)? as usize;
        Some((4, b1 | (b2 << 8) | (b3 << 16)))
    } else if first == 0x83 {
        // Five bytes: 0x83 followed by 4-byte little-endian length
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

    #[test]
    fn test_count_messages_from_real_db() {
        let home = std::env::var("HOME").expect("HOME env var not set");
        let path = format!("{}/Library/Messages/chat.db", home);

        let reader = ChatReader::open(&path).expect("Failed to open chat.db");
        let count = reader.count_messages().expect("Failed to count messages");

        assert!(count > 0, "Expected at least one message in chat.db");
        println!("Found {} messages in chat.db", count);
    }

    #[test]
    fn test_get_recent_messages() {
        let home = std::env::var("HOME").expect("HOME env var not set");
        let path = format!("{}/Library/Messages/chat.db", home);

        let reader = ChatReader::open(&path).expect("Failed to open chat.db");
        let messages = reader.get_recent_messages(10).expect("Failed to get messages");

        assert!(!messages.is_empty(), "Expected at least one message");
        
        println!("\n=== 10 Most Recent Messages ===");
        for msg in &messages {
            let direction = if msg.is_from_me { "→" } else { "←" };
            let text = msg.text.as_deref().unwrap_or("[no text - check attributedBody]");
            println!("{} [{}] {}", direction, msg.rowid, text);
        }
    }

    #[test]
    fn test_500_messages_extraction() {
        let home = std::env::var("HOME").expect("HOME env var not set");
        let path = format!("{}/Library/Messages/chat.db", home);

        let reader = ChatReader::open(&path).expect("Failed to open chat.db");
        let messages = reader.get_recent_messages(20000).expect("Failed to get messages");

        let mut with_text = 0;
        let mut no_text: Vec<i64> = Vec::new();

        for msg in &messages {
            if msg.text.is_some() {
                with_text += 1;
            } else {
                no_text.push(msg.rowid);
            }
        }

        println!("\n=== 20,000 Message Test Results ===");
        println!("✅ Messages with text: {}", with_text);
        println!("📭 Messages without text: {} (system messages, typing indicators, etc.)", no_text.len());
        
        if !no_text.is_empty() {
            println!("\nROWIDs without text: {:?}", no_text);
        }

        let text_rate = (with_text as f64 / messages.len() as f64) * 100.0;
        println!("\nText extraction rate: {:.1}%", text_rate);
        
        // The vast majority of messages should have text
        assert!(text_rate > 95.0, "Expected at least 95% of messages to have text");
    }
}