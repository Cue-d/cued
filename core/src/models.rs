//! Shared data models exposed to Python.

use pyo3::prelude::*;

// ============================================
// PRMD.DB MODELS (App database - source of truth)
// ============================================

/// Person stored in prm.db (merged handle + contact).
#[pyclass]
#[derive(Debug, Clone)]
pub struct Person {
    #[pyo3(get)]
    pub id: i64,
    #[pyo3(get)]
    pub identifier: String, // phone "+12025551234" or email
    #[pyo3(get)]
    pub name: String, // resolved name (contact name or fallback)
    #[pyo3(get)]
    pub service: String, // iMessage, SMS
    #[pyo3(get)]
    pub is_contact: bool, // has Apple Contacts entry
    #[pyo3(get)]
    pub phones: Option<String>, // JSON array of all phones
    #[pyo3(get)]
    pub emails: Option<String>, // JSON array of all emails
    #[pyo3(get)]
    pub company: Option<String>,
    #[pyo3(get)]
    pub notes: Option<String>,
}

#[pymethods]
impl Person {
    fn __repr__(&self) -> String {
        format!("Person(id={}, name='{}')", self.id, self.name)
    }
}

/// Chat stored in prm.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct PrmChat {
    #[pyo3(get)]
    pub id: i64,
    #[pyo3(get)]
    pub identifier: String, // phone/email for 1:1, "chat123" for groups
    #[pyo3(get)]
    pub name: Option<String>, // display name (user-set or computed)
    #[pyo3(get)]
    pub is_group: bool,
    #[pyo3(get)]
    pub last_message_text: Option<String>, // from JOIN
    #[pyo3(get)]
    pub last_message_timestamp: Option<i64>, // Unix timestamp, from JOIN
}

#[pymethods]
impl PrmChat {
    fn __repr__(&self) -> String {
        let name = self.name.as_deref().unwrap_or(&self.identifier);
        format!("PrmChat(id={}, name='{}')", self.id, name)
    }
}

/// Message stored in prm.db (pre-resolved sender).
#[pyclass]
#[derive(Debug, Clone)]
pub struct PrmMessage {
    #[pyo3(get)]
    pub id: i64,
    #[pyo3(get)]
    pub chat_id: i64,
    #[pyo3(get)]
    pub sender_id: Option<i64>, // FK to people.id, NULL if is_from_me
    #[pyo3(get)]
    pub sender_name: Option<String>, // from JOIN with people
    #[pyo3(get)]
    pub text: Option<String>,
    #[pyo3(get)]
    pub timestamp: i64, // Unix timestamp
    #[pyo3(get)]
    pub is_from_me: bool,
    #[pyo3(get)]
    pub is_read: bool,
    #[pyo3(get)]
    pub read_at: Option<i64>, // Unix timestamp
    #[pyo3(get)]
    pub has_attachments: bool,
}

#[pymethods]
impl PrmMessage {
    fn __repr__(&self) -> String {
        let preview = self.text.as_deref().unwrap_or("[no text]");
        let preview = if preview.len() > 30 {
            &preview[..30]
        } else {
            preview
        };
        format!("PrmMessage(id={}, text='{}')", self.id, preview)
    }
}

/// Attachment metadata stored in prm.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Attachment {
    #[pyo3(get)]
    pub id: i64,
    #[pyo3(get)]
    pub message_id: i64,
    #[pyo3(get)]
    pub filename: Option<String>,
    #[pyo3(get)]
    pub path: Option<String>, // full path in ~/Library/Messages/Attachments
    #[pyo3(get)]
    pub mime_type: Option<String>,
    #[pyo3(get)]
    pub uti: Option<String>, // uniform type identifier
    #[pyo3(get)]
    pub size: Option<i64>, // bytes
    #[pyo3(get)]
    pub is_outgoing: bool,
    #[pyo3(get)]
    pub created_at: Option<i64>, // Unix timestamp
}

#[pymethods]
impl Attachment {
    fn __repr__(&self) -> String {
        let name = self.filename.as_deref().unwrap_or("[no filename]");
        format!("Attachment(id={}, filename='{}')", self.id, name)
    }
}

// ============================================
// SYNC MODELS (for transferring from chat.db to prm.db)
// ============================================

/// Handle data for syncing from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SyncHandle {
    #[pyo3(get)]
    pub id: i64, // handle.ROWID
    #[pyo3(get)]
    pub identifier: String, // phone or email
    #[pyo3(get)]
    pub service: String, // iMessage, SMS
}

#[pymethods]
impl SyncHandle {
    fn __repr__(&self) -> String {
        format!(
            "SyncHandle(id={}, identifier='{}')",
            self.id, self.identifier
        )
    }
}

/// Chat data for syncing from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SyncChat {
    #[pyo3(get)]
    pub id: i64, // chat.ROWID
    #[pyo3(get)]
    pub identifier: String, // phone/email for 1:1, "chat123" for groups
    #[pyo3(get)]
    pub display_name: Option<String>,
    #[pyo3(get)]
    pub is_group: bool,
}

#[pymethods]
impl SyncChat {
    fn __repr__(&self) -> String {
        format!("SyncChat(id={}, identifier='{}')", self.id, self.identifier)
    }
}

/// Message data for syncing from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SyncMessage {
    #[pyo3(get)]
    pub id: i64, // message.ROWID
    #[pyo3(get)]
    pub chat_id: i64,
    #[pyo3(get)]
    pub handle_id: i64, // handle.ROWID - used as sender_id (equals people.id since UNIQUE(identifier, service))
    #[pyo3(get)]
    pub text: Option<String>,
    #[pyo3(get)]
    pub timestamp: i64, // Unix timestamp (converted from Apple)
    #[pyo3(get)]
    pub is_from_me: bool,
    #[pyo3(get)]
    pub is_read: bool,
    #[pyo3(get)]
    pub read_at: Option<i64>, // Unix timestamp
    #[pyo3(get)]
    pub has_attachments: bool,
}

#[pymethods]
impl SyncMessage {
    fn __repr__(&self) -> String {
        format!("SyncMessage(id={}, chat_id={})", self.id, self.chat_id)
    }
}

/// Attachment data for syncing from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SyncAttachment {
    #[pyo3(get)]
    pub id: i64, // attachment.ROWID
    #[pyo3(get)]
    pub message_id: i64,
    #[pyo3(get)]
    pub filename: Option<String>,
    #[pyo3(get)]
    pub path: Option<String>,
    #[pyo3(get)]
    pub mime_type: Option<String>,
    #[pyo3(get)]
    pub uti: Option<String>,
    #[pyo3(get)]
    pub size: Option<i64>,
    #[pyo3(get)]
    pub is_outgoing: bool,
    #[pyo3(get)]
    pub created_at: Option<i64>, // Unix timestamp
}

#[pymethods]
impl SyncAttachment {
    fn __repr__(&self) -> String {
        format!(
            "SyncAttachment(id={}, message_id={})",
            self.id, self.message_id
        )
    }
}

// ============================================
// LEGACY MODELS (kept for backward compatibility during migration)
// ============================================

/// iMessage message from chat.db (legacy - use PrmMessage for queries).
#[pyclass]
#[derive(Debug, Clone)]
pub struct Message {
    #[pyo3(get)]
    pub rowid: i64,
    #[pyo3(get)]
    pub text: Option<String>,
    #[pyo3(get)]
    pub date: i64, // Apple timestamp (nanoseconds since 2001-01-01)
    #[pyo3(get)]
    pub is_from_me: bool,
    #[pyo3(get)]
    pub is_read: bool, // 1 = read, 0 = unread
    #[pyo3(get)]
    pub date_read: Option<i64>, // Apple timestamp when message was read
    #[pyo3(get)]
    pub handle_id: i64, // FK to handle.ROWID (0 = sent from me)
    #[pyo3(get)]
    pub chat_id: Option<i64>, // FK to chat.ROWID (set when queried via chat)
}

#[pymethods]
impl Message {
    fn __repr__(&self) -> String {
        let preview = self.text.as_deref().unwrap_or("[no text]");
        let preview = if preview.len() > 30 {
            &preview[..30]
        } else {
            preview
        };
        format!("Message(rowid={}, text='{}')", self.rowid, preview)
    }
}

/// Contact fetched from Apple Contacts via AppleScript.
#[pyclass]
#[derive(Debug, Clone)]
pub struct FetchedContact {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub emails: Vec<String>,
    #[pyo3(get)]
    pub phones: Vec<String>,
    #[pyo3(get)]
    pub company: Option<String>,
    #[pyo3(get)]
    pub notes: Option<String>,
}

#[pymethods]
impl FetchedContact {
    fn __repr__(&self) -> String {
        format!(
            "FetchedContact(name='{}', emails={}, phones={})",
            self.name,
            self.emails.len(),
            self.phones.len()
        )
    }
}

/// iMessage chat from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Chat {
    #[pyo3(get)]
    pub rowid: i64,
    #[pyo3(get)]
    pub chat_identifier: String, // phone/email for 1:1, or chat{id} for groups
    #[pyo3(get)]
    pub display_name: Option<String>, // user-set name for groups
    #[pyo3(get)]
    pub is_group: bool, // derived from style (43=1:1, 45=group)
    #[pyo3(get)]
    pub last_message_date: i64, // Apple timestamp of most recent message
    #[pyo3(get)]
    pub last_message_text: Option<String>, // preview text
}

#[pymethods]
impl Chat {
    fn __repr__(&self) -> String {
        let name = self
            .display_name
            .as_deref()
            .unwrap_or(&self.chat_identifier);
        format!("Chat(rowid={}, name='{}')", self.rowid, name)
    }
}

/// iMessage handle (phone/email identifier) from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Handle {
    #[pyo3(get)]
    pub rowid: i64,
    #[pyo3(get)]
    pub id: String, // phone number (+12025551234) or email
    #[pyo3(get)]
    pub service: String, // iMessage, SMS, etc.
}

#[pymethods]
impl Handle {
    fn __repr__(&self) -> String {
        format!("Handle(rowid={}, id='{}')", self.rowid, self.id)
    }
}
