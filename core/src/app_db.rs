//! Dumb data store for prm.db (app's SQLite database).

use pyo3::prelude::*;
use rusqlite::{Connection, params};

use crate::models::{Contact, FetchedContact};
use crate::utils::now_timestamp;

/// Internal constructor for testing (bypasses PyO3).
#[cfg(test)]
impl AppDb {
    fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        Self { conn }
    }
}

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
        let conn = Connection::open(path).map_err(|e| {
            pyo3::exceptions::PyIOError::new_err(format!("Failed to open db: {}", e))
        })?;
        Ok(Self { conn })
    }

    /// Initialize the database schema.
    pub fn init_schema(&self) -> PyResult<()> {
        self.conn
            .execute_batch(
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
            ",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Schema error: {}", e))
            })?;
        Ok(())
    }

    /// Upsert multiple contacts.
    pub fn upsert_contacts(&mut self, contacts: Vec<FetchedContact>) -> PyResult<usize> {
        let tx = self.conn.transaction().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Transaction error: {}", e))
        })?;

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

        tx.commit().map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Commit error: {}", e))
        })?;
        Ok(count)
    }

    /// Get all contacts from the database.
    pub fn get_all_contacts(&self) -> PyResult<Vec<Contact>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, name, emails, phones, company, notes, created_at, updated_at
             FROM contacts ORDER BY name",
            )
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
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
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Query error: {}", e))
            })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("Row error: {}", e))
            })?);
        }
        Ok(result)
    }

    /// Get contact count.
    pub fn contact_count(&self) -> PyResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Count error: {}", e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> AppDb {
        let db = AppDb::open_in_memory();
        // Use direct SQL since init_schema returns PyResult
        db.conn
            .execute_batch(
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
            ",
            )
            .unwrap();
        db
    }

    #[test]
    fn test_insert_single_contact() {
        let db = create_test_db();
        let now = now_timestamp();
        let emails_json = serde_json::to_string(&vec!["alice@example.com"]).unwrap();
        let phones_json = serde_json::to_string(&vec!["+12025551234"]).unwrap();

        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    "Alice Smith",
                    emails_json,
                    phones_json,
                    "Acme Corp",
                    "Met at conference",
                    now,
                ],
            )
            .unwrap();

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify the inserted data
        let (name, company): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT name, company FROM contacts WHERE name = ?",
                ["Alice Smith"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Alice Smith");
        assert_eq!(company, Some("Acme Corp".to_string()));
    }

    #[test]
    fn test_upsert_updates_existing_contact() {
        let db = create_test_db();
        let now = now_timestamp();

        // Insert initial contact
        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Bob Jones', '[\"bob@old.com\"]', '[]', 'Old Corp', NULL, ?1, ?1)",
                [now],
            )
            .unwrap();

        // Upsert with same name but different data
        let emails_json = serde_json::to_string(&vec!["bob@new.com"]).ok();
        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Bob Jones', ?1, '[]', 'New Corp', 'Updated', ?2, ?2)
                 ON CONFLICT(name) DO UPDATE SET
                    emails = excluded.emails,
                    phones = excluded.phones,
                    company = excluded.company,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at",
                params![emails_json, now],
            )
            .unwrap();

        // Should still be 1 contact
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify the data was updated
        let (company, notes): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT company, notes FROM contacts WHERE name = 'Bob Jones'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(company, Some("New Corp".to_string()));
        assert_eq!(notes, Some("Updated".to_string()));
    }

    #[test]
    fn test_get_all_contacts_ordered_by_name() {
        let db = create_test_db();
        let now = now_timestamp();

        // Insert contacts out of alphabetical order
        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Zara', NULL, NULL, NULL, NULL, ?1, ?1)",
                [now],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Alice', NULL, NULL, NULL, NULL, ?1, ?1)",
                [now],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Mike', NULL, NULL, NULL, NULL, ?1, ?1)",
                [now],
            )
            .unwrap();

        // Query contacts ordered by name
        let mut stmt = db
            .conn
            .prepare("SELECT id, name, emails, phones, company, notes, created_at, updated_at FROM contacts ORDER BY name")
            .unwrap();
        let contacts: Vec<Contact> = stmt
            .query_map([], |row| {
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
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(contacts.len(), 3);
        assert_eq!(contacts[0].name, "Alice");
        assert_eq!(contacts[1].name, "Mike");
        assert_eq!(contacts[2].name, "Zara");
    }

    #[test]
    fn test_contact_with_multiple_emails_and_phones() {
        let db = create_test_db();
        let now = now_timestamp();

        let emails = vec!["alice@work.com", "alice@personal.com"];
        let phones = vec!["+12025551234", "+12025555678"];
        let emails_json = serde_json::to_string(&emails).unwrap();
        let phones_json = serde_json::to_string(&phones).unwrap();

        db.conn
            .execute(
                "INSERT INTO contacts (name, emails, phones, company, notes, created_at, updated_at)
                 VALUES ('Alice', ?1, ?2, NULL, NULL, ?3, ?3)",
                params![emails_json, phones_json, now],
            )
            .unwrap();

        let (stored_emails, stored_phones): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT emails, phones FROM contacts WHERE name = 'Alice'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        // Verify JSON arrays are stored correctly
        let parsed_emails: Vec<String> = serde_json::from_str(&stored_emails.unwrap()).unwrap();
        let parsed_phones: Vec<String> = serde_json::from_str(&stored_phones.unwrap()).unwrap();

        assert_eq!(parsed_emails.len(), 2);
        assert_eq!(parsed_phones.len(), 2);
        assert!(parsed_emails.contains(&"alice@work.com".to_string()));
        assert!(parsed_phones.contains(&"+12025551234".to_string()));
    }
}
