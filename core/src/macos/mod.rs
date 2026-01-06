//! macOS integrations via AppleScript.
//!
//! - `contacts`: Read from macOS Contacts app
//! - `send`: Send messages via Messages app

pub mod contacts;
pub mod send;

pub use contacts::{fetch_all_contact_names, fetch_contacts_by_names};
pub use send::{SendResult, send_message, send_to_group};
