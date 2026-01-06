//! PRM Core - Rust library exposed to Python via PyO3.

pub mod db;
pub mod macos;
pub mod models;
pub mod sync;
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

    // PRM V1 models (Actions, Search, Embeddings)
    m.add_class::<models::Action>()?;
    m.add_class::<models::SearchResult>()?;
    m.add_class::<models::UnansweredChat>()?;
    m.add_class::<models::PendingEmbedding>()?;
    m.add_class::<models::StoredEmbedding>()?;
    m.add_class::<models::QueuedAnalysis>()?;

    // Database classes (from db module)
    m.add_class::<db::AppDb>()?;
    m.add_class::<db::ChatReader>()?;

    // Utility functions
    m.add_function(wrap_pyfunction!(utils::normalize_phone, m)?)?;
    m.add_function(wrap_pyfunction!(utils::normalize_email, m)?)?;
    m.add_function(wrap_pyfunction!(utils::apple_to_unix, m)?)?;

    // macOS integrations (contacts and messaging)
    m.add_function(wrap_pyfunction!(macos::fetch_all_contact_names, m)?)?;
    m.add_function(wrap_pyfunction!(macos::fetch_contacts_by_names, m)?)?;
    m.add_class::<macos::SendResult>()?;
    m.add_function(wrap_pyfunction!(macos::send_message, m)?)?;
    m.add_function(wrap_pyfunction!(macos::send_to_group, m)?)?;

    // Background sync watcher
    m.add_class::<sync::SyncWatcher>()?;

    Ok(())
}
