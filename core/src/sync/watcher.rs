//! Background sync watcher - continuously syncs new messages from chat.db to prm.db.
//!
//! This runs in a background thread and polls for new messages every POLL_INTERVAL_MS.
//! It's designed to provide near-real-time message updates without the overhead of
//! running the full Python sync on every poll.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use pyo3::prelude::*;
use rusqlite::{Connection, OpenFlags, params};

use crate::models::{SyncAttachment, SyncMessage};
use crate::utils::{apple_to_unix, extract_text_from_attributed_body, now_timestamp};

/// How often to poll for new messages (milliseconds).
const POLL_INTERVAL_MS: u64 = 500;

/// Batch size for message sync.
const MESSAGE_BATCH_SIZE: u32 = 100;

/// Batch size for attachment sync.
const ATTACHMENT_BATCH_SIZE: u32 = 100;

/// Maximum retries for database operations on lock errors.
const MAX_DB_RETRIES: u32 = 5;

/// Base delay for exponential backoff (milliseconds).
const RETRY_BASE_DELAY_MS: u64 = 100;

/// Background sync watcher that continuously syncs messages from chat.db to prm.db.
#[pyclass]
pub struct SyncWatcher {
    /// Flag to signal the background thread to stop.
    running: Arc<AtomicBool>,
    /// Handle to the background thread.
    thread_handle: Option<thread::JoinHandle<()>>,
}

#[pymethods]
impl SyncWatcher {
    /// Create a new SyncWatcher (not started yet).
    #[new]
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            thread_handle: None,
        }
    }

    /// Start the background sync watcher.
    ///
    /// Args:
    ///     chat_db_path: Path to chat.db (read-only iMessage database)
    ///     app_db_path: Path to prm.db (our app database)
    pub fn start(&mut self, chat_db_path: String, app_db_path: String) -> PyResult<()> {
        if self.running.load(Ordering::SeqCst) {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(
                "SyncWatcher is already running",
            ));
        }

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();

        let handle = thread::spawn(move || {
            if let Err(e) = sync_loop(&chat_db_path, &app_db_path, running) {
                eprintln!("SyncWatcher error: {}", e);
            }
        });

        self.thread_handle = Some(handle);
        Ok(())
    }

    /// Stop the background sync watcher.
    pub fn stop(&mut self) -> PyResult<()> {
        self.running.store(false, Ordering::SeqCst);

        if let Some(handle) = self.thread_handle.take() {
            handle.join().map_err(|_| {
                pyo3::exceptions::PyRuntimeError::new_err("Failed to join sync thread")
            })?;
        }

        Ok(())
    }

    /// Check if the watcher is currently running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

impl Default for SyncWatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Main sync loop - runs until `running` is set to false.
fn sync_loop(
    chat_db_path: &str,
    app_db_path: &str,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    // Open chat.db read-only
    let chat_conn = Connection::open_with_flags(chat_db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open chat.db: {}", e))?;

    // Open prm.db read-write
    let mut app_conn =
        Connection::open(app_db_path).map_err(|e| format!("Failed to open prm.db: {}", e))?;

    // Enable WAL mode for better concurrent access - this allows the Python
    // backend to read/write while we're syncing without "database is locked" errors
    app_conn
        .query_row("PRAGMA journal_mode = WAL", [], |_row| Ok(()))
        .map_err(|e| format!("Failed to enable WAL mode: {}", e))?;

    // Set busy timeout to wait up to 30 seconds if database is locked
    // (increased from 5s to handle parallel LLM processing writes)
    app_conn
        .query_row("PRAGMA busy_timeout = 30000", [], |_row| Ok(()))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    // Disable foreign keys for the watcher - it only syncs messages/attachments
    // for existing chats. New chats are synced by the full Python sync.
    // This prevents FK errors when a message arrives for a chat that hasn't
    // been synced yet (the full sync will catch it on next run).
    app_conn
        .execute_batch("PRAGMA foreign_keys = OFF")
        .map_err(|e| format!("Failed to disable foreign keys: {}", e))?;

    let poll_duration = Duration::from_millis(POLL_INTERVAL_MS);

    while running.load(Ordering::SeqCst) {
        // Sync new messages
        if let Err(e) = sync_messages_batch(&chat_conn, &mut app_conn) {
            eprintln!("Message sync error: {}", e);
        }

        // Sync new attachments
        if let Err(e) = sync_attachments_batch(&chat_conn, &mut app_conn) {
            eprintln!("Attachment sync error: {}", e);
        }

        // Sleep before next poll
        thread::sleep(poll_duration);
    }

    Ok(())
}

/// Sync one batch of new messages from chat.db to prm.db.
fn sync_messages_batch(chat_conn: &Connection, app_conn: &mut Connection) -> Result<usize, String> {
    // Get last synced message rowid
    let last_rowid: i64 = app_conn
        .query_row(
            "SELECT value FROM sync_state WHERE key = 'last_message_rowid'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to get last_message_rowid: {}", e))?;

    // Fetch new messages from chat.db
    let messages = get_messages_since(chat_conn, last_rowid, MESSAGE_BATCH_SIZE)?;

    if messages.is_empty() {
        return Ok(0);
    }

    // Insert into prm.db using a transaction
    let count = insert_messages(app_conn, &messages)?;

    Ok(count)
}

/// Sync one batch of new attachments from chat.db to prm.db.
fn sync_attachments_batch(
    chat_conn: &Connection,
    app_conn: &mut Connection,
) -> Result<usize, String> {
    // Get last synced attachment rowid
    let last_rowid: i64 = app_conn
        .query_row(
            "SELECT value FROM sync_state WHERE key = 'last_attachment_rowid'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to get last_attachment_rowid: {}", e))?;

    // Fetch new attachments from chat.db
    let attachments = get_attachments_since(chat_conn, last_rowid, ATTACHMENT_BATCH_SIZE)?;

    if attachments.is_empty() {
        return Ok(0);
    }

    // Insert into prm.db using a transaction
    let count = insert_attachments(app_conn, &attachments)?;

    Ok(count)
}

/// Get messages with ROWID > since_rowid from chat.db.
/// Excludes reactions (associated_message_type >= 2000).
fn get_messages_since(
    conn: &Connection,
    since_rowid: i64,
    limit: u32,
) -> Result<Vec<SyncMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.ROWID, cmj.chat_id, m.handle_id, m.text, m.date, m.is_from_me,
                    m.is_read, m.date_read, m.attributedBody,
                    (SELECT COUNT(*) > 0 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as has_attachments,
                    m.is_sent, m.is_delivered, m.date_delivered, m.error
             FROM message m
             INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
             WHERE m.ROWID > ?
               AND (m.associated_message_type IS NULL OR m.associated_message_type < 2000)
             ORDER BY m.ROWID
             LIMIT ?",
        )
        .map_err(|e| format!("Query error: {}", e))?;

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
                None => attributed_body.and_then(|blob| extract_text_from_attributed_body(&blob)),
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
        .map_err(|e| format!("Query error: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(result)
}

/// Get attachments with ROWID > since_rowid from chat.db.
fn get_attachments_since(
    conn: &Connection,
    since_rowid: i64,
    limit: u32,
) -> Result<Vec<SyncAttachment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.ROWID, maj.message_id, a.filename, a.filename as path, a.mime_type,
                    a.uti, a.total_bytes, a.is_outgoing, a.created_date
             FROM attachment a
             INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
             WHERE a.ROWID > ?
             ORDER BY a.ROWID
             LIMIT ?",
        )
        .map_err(|e| format!("Query error: {}", e))?;

    let rows = stmt
        .query_map([since_rowid, limit as i64], |row| {
            let apple_created: Option<i64> = row.get(8)?;

            Ok(SyncAttachment {
                id: row.get(0)?,
                message_id: row.get(1)?,
                filename: row.get(2)?,
                path: row.get(3)?,
                mime_type: row.get(4)?,
                uti: row.get(5)?,
                size: row.get(6)?,
                is_outgoing: row.get(7)?,
                created_at: apple_created.map(apple_to_unix),
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(result)
}

/// Insert messages into prm.db using a transaction with retry logic.
fn insert_messages(conn: &mut Connection, messages: &[SyncMessage]) -> Result<usize, String> {
    if messages.is_empty() {
        return Ok(0);
    }

    // Retry with exponential backoff on database lock errors
    for attempt in 0..MAX_DB_RETRIES {
        match insert_messages_inner(conn, messages) {
            Ok(count) => return Ok(count),
            Err(e) if e.contains("database is locked") || e.contains("SQLITE_BUSY") => {
                if attempt + 1 < MAX_DB_RETRIES {
                    let delay = RETRY_BASE_DELAY_MS * (1 << attempt); // Exponential backoff
                    thread::sleep(Duration::from_millis(delay));
                    continue;
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err("Max retries exceeded for insert_messages".to_string())
}

/// Inner function for insert_messages (no retry logic).
fn insert_messages_inner(conn: &mut Connection, messages: &[SyncMessage]) -> Result<usize, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Transaction error: {}", e))?;

    let now = now_timestamp();
    let mut count = 0;

    for msg in messages {
        // sender_id is handle_id if not from_me, NULL if from_me
        let sender_id = if msg.is_from_me {
            None
        } else if msg.handle_id > 0 {
            Some(msg.handle_id)
        } else {
            None
        };

        tx.execute(
            "INSERT OR REPLACE INTO messages (id, chat_id, sender_id, text, timestamp, is_from_me, is_read, read_at, has_attachments, is_sent, is_delivered, date_delivered, error, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                msg.is_sent as i32,
                msg.is_delivered as i32,
                msg.date_delivered,
                msg.error,
                now,
            ],
        )
        .map_err(|e| format!("Insert message error: {}", e))?;
        count += 1;
    }

    // Update sync state within the same transaction
    if let Some(max_id) = messages.iter().map(|m| m.id).max() {
        tx.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_message_rowid', ?)",
            [max_id],
        )
        .map_err(|e| format!("Failed to update last_message_rowid: {}", e))?;
    }

    tx.commit().map_err(|e| format!("Commit error: {}", e))?;

    Ok(count)
}

/// Insert attachments into prm.db using a transaction with retry logic.
/// Skips attachments whose message_id doesn't exist in the messages table.
fn insert_attachments(
    conn: &mut Connection,
    attachments: &[SyncAttachment],
) -> Result<usize, String> {
    if attachments.is_empty() {
        return Ok(0);
    }

    // Retry with exponential backoff on database lock errors
    for attempt in 0..MAX_DB_RETRIES {
        match insert_attachments_inner(conn, attachments) {
            Ok(count) => return Ok(count),
            Err(e) if e.contains("database is locked") || e.contains("SQLITE_BUSY") => {
                if attempt + 1 < MAX_DB_RETRIES {
                    let delay = RETRY_BASE_DELAY_MS * (1 << attempt); // Exponential backoff
                    thread::sleep(Duration::from_millis(delay));
                    continue;
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err("Max retries exceeded for insert_attachments".to_string())
}

/// Inner function for insert_attachments (no retry logic).
fn insert_attachments_inner(
    conn: &mut Connection,
    attachments: &[SyncAttachment],
) -> Result<usize, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Transaction error: {}", e))?;

    let now = now_timestamp();
    let mut count = 0;

    for att in attachments {
        // Check if the message exists before inserting attachment
        let message_exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?)",
                params![att.message_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !message_exists {
            // Skip attachments for messages that don't exist (e.g., not joined to a chat)
            continue;
        }

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
        .map_err(|e| format!("Insert attachment error: {}", e))?;
        count += 1;
    }

    // Update sync state within the same transaction
    if let Some(max_id) = attachments.iter().map(|a| a.id).max() {
        tx.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_attachment_rowid', ?)",
            [max_id],
        )
        .map_err(|e| format!("Failed to update last_attachment_rowid: {}", e))?;
    }

    tx.commit().map_err(|e| format!("Commit error: {}", e))?;

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_watcher_default() {
        let watcher = SyncWatcher::new();
        assert!(!watcher.is_running());
    }
}
