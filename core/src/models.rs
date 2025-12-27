//! Shared data models exposed to Python.

use pyo3::prelude::*;

/// iMessage message from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Message {
    #[pyo3(get)]
    pub rowid: i64,
    #[pyo3(get)]
    pub text: Option<String>,
    #[pyo3(get)]
    pub date: i64,  // Apple timestamp (nanoseconds since 2001-01-01)
    #[pyo3(get)]
    pub is_from_me: bool,
    #[pyo3(get)]
    pub handle_id: i64,  // FK to handle.ROWID (0 = sent from me)
    #[pyo3(get)]
    pub chat_id: Option<i64>,  // FK to chat.ROWID (set when queried via chat)
}

#[pymethods]
impl Message {
    fn __repr__(&self) -> String {
        let preview = self.text.as_deref().unwrap_or("[no text]");
        let preview = if preview.len() > 30 { &preview[..30] } else { preview };
        format!("Message(rowid={}, text='{}')", self.rowid, preview)
    }
}

/// Contact stored in prm.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Contact {
    #[pyo3(get)]
    pub id: i64,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub emails: Option<String>,  // JSON array
    #[pyo3(get)]
    pub phones: Option<String>,  // JSON array
    #[pyo3(get)]
    pub company: Option<String>,
    #[pyo3(get)]
    pub notes: Option<String>,
    #[pyo3(get)]
    pub created_at: i64,
    #[pyo3(get)]
    pub updated_at: i64,
}

#[pymethods]
impl Contact {
    fn __repr__(&self) -> String {
        format!("Contact(id={}, name='{}')", self.id, self.name)
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

/// iMessage chat/conversation from chat.db.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Chat {
    #[pyo3(get)]
    pub rowid: i64,
    #[pyo3(get)]
    pub chat_identifier: String,  // phone/email for 1:1, or chat{id} for groups
    #[pyo3(get)]
    pub display_name: Option<String>,  // user-set name for groups
    #[pyo3(get)]
    pub is_group: bool,  // derived from style (43=1:1, 45=group)
    #[pyo3(get)]
    pub last_message_date: i64,  // Apple timestamp of most recent message
    #[pyo3(get)]
    pub last_message_text: Option<String>,  // preview text
}

#[pymethods]
impl Chat {
    fn __repr__(&self) -> String {
        let name = self.display_name.as_deref().unwrap_or(&self.chat_identifier);
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
    pub id: String,  // phone number (+12025551234) or email
    #[pyo3(get)]
    pub service: String,  // iMessage, SMS, etc.
}

#[pymethods]
impl Handle {
    fn __repr__(&self) -> String {
        format!("Handle(rowid={}, id='{}')", self.rowid, self.id)
    }
}
