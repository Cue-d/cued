//! PRM Core - Rust library exposed to Python via PyO3.

pub mod app_db;
pub mod chat_reader;
pub mod contacts;
pub mod messaging;
pub mod models;
pub mod sync_watcher;
pub mod utils;

use pyo3::prelude::*;

/// Python module - this is what Python will import as 'core'
#[pymodule]
fn core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Legacy data classes (for backward compatibility during migration)
    m.add_class::<models::Message>()?;
    m.add_class::<models::FetchedContact>()?;
    m.add_class::<models::Chat>()?;
    m.add_class::<models::Handle>()?;

    // PRM.DB models (main application models)
    m.add_class::<models::Person>()?;
    m.add_class::<models::PrmChat>()?;
    m.add_class::<models::PrmMessage>()?;
    m.add_class::<models::Attachment>()?;

    // Sync models (for transferring from chat.db to prm.db)
    m.add_class::<models::SyncHandle>()?;
    m.add_class::<models::SyncChat>()?;
    m.add_class::<models::SyncMessage>()?;
    m.add_class::<models::SyncAttachment>()?;

    // Database classes
    m.add_class::<app_db::AppDb>()?;
    m.add_class::<chat_reader::ChatReader>()?;

    // Utility functions
    m.add_function(wrap_pyfunction!(utils::normalize_phone, m)?)?;
    m.add_function(wrap_pyfunction!(utils::normalize_email, m)?)?;
    m.add_function(wrap_pyfunction!(utils::apple_to_unix, m)?)?;

    // Contact fetching functions
    m.add_function(wrap_pyfunction!(contacts::fetch_all_contact_names, m)?)?;
    m.add_function(wrap_pyfunction!(contacts::fetch_contacts_by_names, m)?)?;

    // Messaging functions
    m.add_class::<messaging::SendResult>()?;
    m.add_function(wrap_pyfunction!(messaging::send_message, m)?)?;
    m.add_function(wrap_pyfunction!(messaging::send_to_group, m)?)?;

    // Background sync watcher
    m.add_class::<sync_watcher::SyncWatcher>()?;

    Ok(())
}
