//! Database modules for PRM.
//!
//! - `prm_db`: Read/write operations for prm.db (app database)
//! - `imessage_reader`: Read-only access to chat.db (iMessage database)

pub mod imessage_reader;
pub mod prm_db;

pub use imessage_reader::ChatReader;
pub use prm_db::AppDb;
