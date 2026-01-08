//! macOS integrations via AppleScript.
//!
//! - `contacts`: Read from macOS Contacts app
//! - `send`: Send messages via Messages app

pub mod contacts;
pub mod send;

pub use contacts::{
    fetch_all_contact_ids, fetch_all_contact_names, fetch_all_contacts_for_sync,
    fetch_contacts_by_names, fetch_contacts_modified_since,
};
pub use send::{SendResult, send_message, send_to_group};
