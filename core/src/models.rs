#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub rowid: i64,
    pub text: Option<String>,  // Can be NULL - modern macOS stores in attributedBody blob
    pub date: i64,             // Apple timestamp (nanoseconds since 2001-01-01)
    pub is_from_me: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub emails: Option<String>,         // JSON array of email strings
    pub phones: Option<String>,         // JSON array of phone strings
    pub company: Option<String>,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}