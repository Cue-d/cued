//! Background synchronization.
//!
//! - `watcher`: SyncWatcher for real-time chat.db → prm.db sync

pub mod watcher;

pub use watcher::SyncWatcher;
