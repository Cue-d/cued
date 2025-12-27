//! iMessage sending via AppleScript.

use pyo3::prelude::*;
use std::process::Command;

/// Result of a send attempt.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SendResult {
    #[pyo3(get)]
    pub success: bool,
    #[pyo3(get)]
    pub error: Option<String>,
    #[pyo3(get)]
    pub recipient: String,
}

#[pymethods]
impl SendResult {
    fn __repr__(&self) -> String {
        if self.success {
            format!("SendResult(success=True, recipient='{}')", self.recipient)
        } else {
            format!(
                "SendResult(success=False, error='{}', recipient='{}')",
                self.error.as_deref().unwrap_or("unknown"),
                self.recipient
            )
        }
    }
}

/// Send a text message via iMessage to a phone number or email.
#[pyfunction]
pub fn send_message(recipient: &str, message: &str) -> PyResult<SendResult> {
    let escaped = escape_applescript_string(message);
    let escaped_recipient = escape_applescript_string(recipient);

    let script = format!(
        r#"
        tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant "{}" of targetService
            send "{}" to targetBuddy
        end tell
        "#,
        escaped_recipient, escaped
    );

    execute_applescript(&script, recipient)
}

/// Send a message to a group chat by chat identifier.
#[pyfunction]
pub fn send_to_group(chat_identifier: &str, message: &str) -> PyResult<SendResult> {
    let escaped = escape_applescript_string(message);

    // Format the chat ID for Messages.app: "iMessage;+;chat..."
    let full_chat_id = if chat_identifier.starts_with("chat") {
        format!("iMessage;+;{}", chat_identifier)
    } else {
        chat_identifier.to_string()
    };
    let escaped_chat = escape_applescript_string(&full_chat_id);

    let script = format!(
        r#"
        tell application "Messages"
            set targetChat to chat id "{}"
            send "{}" to targetChat
        end tell
        "#,
        escaped_chat, escaped
    );

    execute_applescript(&script, chat_identifier)
}

/// Escape a string for use in AppleScript.
fn escape_applescript_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Execute an AppleScript and return a SendResult.
fn execute_applescript(script: &str, recipient: &str) -> PyResult<SendResult> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    if output.status.success() {
        Ok(SendResult {
            success: true,
            error: None,
            recipient: recipient.to_string(),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(SendResult {
            success: false,
            error: Some(stderr.trim().to_string()),
            recipient: recipient.to_string(),
        })
    }
}
