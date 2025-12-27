#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub rowid: i64,
    pub text: Option<String>,  // Can be NULL - modern macOS stores in attributedBody blob
    pub date: i64,             // Apple timestamp (nanoseconds since 2001-01-01)
    pub is_from_me: bool,
}