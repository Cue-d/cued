//! Dumb data store for prm.db (app's SQLite database).

use pyo3::prelude::*;
use rusqlite::{Connection, params};

use crate::models::{Contact, FetchedContact};
use crate::utils::now_timestamp;

/// App database wrapper.
#[pyclass(unsendable)]
pub struct AppDb {
    conn: Connection,
}

#[pymethods]
impl AppDb {
    /// Open or create the database at the given path.
    #[new]
    pub fn open(path: &str) -> PyResult<Self> {
        let conn = Connection::open(path)
            .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Failed to open db: {}", e)))?;
        Ok(Self { conn })
    }

    /// Initialize the database schema.
    pub fn init_schema(&self) -> PyResult<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                emails TEXT,
                phones TEXT,
                company TEXT,
                notes TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
            "
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Schema error: {}", e)))?;
        Ok(())
    }

    /// Upsert multiple contacts.
    pub fn upsert_contacts(&mut self, contacts: Vec<FetchedContact>) -> PyResult<usize> {
        let tx = self.conn.transaction()
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e)))?;

        let mut count = 0;
        for contact in &contacts {
            let now = now_timestamp();
            let emails_json = serde_json::to_string(&contact.emails).ok();
            let phones_json = serde_json::to_string(&contact.phones).ok();

            tx.execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(name) DO UPDATE SET
                    emails = excluded.emails,
                    phones = excluded.phones,
                    company = excluded.company,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at",
                params![
                    contact.name,
                    emails_json,
                    phones_json,
                    contact.company,
                    contact.notes,
                    now,
                ],
            ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Upsert error: {}", e)))?;
            count += 1;
        }

        tx.commit()
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Commit error: {}", e)))?;
        Ok(count)
    }

    /// Get all contacts from the database.
    pub fn get_all_contacts(&self) -> PyResult<Vec<Contact>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, emails, phones, company, notes, created_at, updated_at
             FROM contacts ORDER BY name"
        ).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let rows = stmt.query_map([], |row| {
            Ok(Contact {
                id: row.get(0)?,
                name: row.get(1)?,
                emails: row.get(2)?,
                phones: row.get(3)?,
                company: row.get(4)?,
                notes: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e)))?);
        }
        Ok(result)
    }

    /// Get contact count.
    pub fn contact_count(&self) -> PyResult<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }
}
