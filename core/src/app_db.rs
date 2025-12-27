use rusqlite::{Connection, Result, params};
use crate::contacts::{FetchedContact, fetch_all_contacts_with_details, now_timestamp};
use crate::models::Contact;

pub struct AppDb {
    conn: Connection,
}

impl AppDb {
    /// Open or create the app database at the given path
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        Ok(Self { conn })
    }

    /// Initialize the database schema (creates tables if they don't exist)
    pub fn init_schema(&self) -> Result<()> {
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
        )?;
        Ok(())
    }

    /// Upsert a contact (insert or update if name exists)
    pub fn upsert_contact(&self, contact: &FetchedContact) -> Result<i64> {
        let now = now_timestamp();
        let emails_json = serde_json::to_string(&contact.emails).ok();
        let phones_json = serde_json::to_string(&contact.phones).ok();

        self.conn.execute(
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
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    /// Upsert multiple contacts in a transaction
    pub fn upsert_contacts_batch(&mut self, contacts: &[FetchedContact]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut count = 0;

        for contact in contacts {
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
            )?;
            count += 1;
        }

        tx.commit()?;
        Ok(count)
    }

    /// Get all contacts from the database
    pub fn get_all_contacts(&self) -> Result<Vec<Contact>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, emails, phones, company, notes, created_at, updated_at 
             FROM contacts ORDER BY name"
        )?;

        let contacts = stmt.query_map([], |row| {
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
        })?;

        contacts.collect()
    }

    /// Get contact count
    pub fn contact_count(&self) -> Result<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
    }

    /// Sync all contacts from Apple Contacts using batched fetching
    /// Returns (total_synced, existing_count_before)
    pub fn sync_all_contacts<F>(&mut self, batch_size: usize, on_progress: F) -> std::result::Result<(usize, usize), String>
    where
        F: FnMut(usize, usize),
    {
        // Get existing contact count
        let before_count = self.contact_count().map_err(|e| e.to_string())? as usize;

        // Fetch all contacts with batched details
        let fetched = fetch_all_contacts_with_details(batch_size, on_progress)?;

        // Upsert all contacts in a single transaction
        let upserted = self.upsert_contacts_batch(&fetched).map_err(|e| e.to_string())?;

        Ok((upserted, before_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_schema_in_memory() {
        let db = AppDb::open(":memory:").expect("Failed to open in-memory database");
        db.init_schema().expect("Failed to create schema");

        let count = db.contact_count().expect("Failed to count contacts");
        assert_eq!(count, 0, "New contacts table should be empty");
        println!("✅ Schema created successfully, contacts table exists");
    }

    #[test]
    fn test_upsert_contact() {
        let db = AppDb::open(":memory:").expect("Failed to open in-memory database");
        db.init_schema().expect("Failed to create schema");

        let contact = FetchedContact {
            name: "Alice Smith".to_string(),
            emails: vec!["alice@example.com".to_string()],
            phones: vec!["+1-555-123-4567".to_string()],
            company: Some("Acme Inc".to_string()),
            notes: None,
        };

        db.upsert_contact(&contact).expect("Failed to upsert contact");
        
        let count = db.contact_count().expect("Failed to count");
        assert_eq!(count, 1);

        // Upsert again (should update, not insert)
        db.upsert_contact(&contact).expect("Failed to upsert contact again");
        let count = db.contact_count().expect("Failed to count");
        assert_eq!(count, 1, "Should still be 1 contact after upsert");

        println!("✅ Upsert works correctly");
    }

    #[test]
    fn test_get_all_contacts() {
        let db = AppDb::open(":memory:").expect("Failed to open in-memory database");
        db.init_schema().expect("Failed to create schema");

        let contacts_to_insert = vec![
            FetchedContact {
                name: "Alice".to_string(),
                emails: vec!["alice@test.com".to_string()],
                phones: vec![],
                company: None,
                notes: None,
            },
            FetchedContact {
                name: "Bob".to_string(),
                emails: vec![],
                phones: vec!["555-1234".to_string()],
                company: Some("Bob's Shop".to_string()),
                notes: Some("Good guy".to_string()),
            },
        ];

        for c in &contacts_to_insert {
            db.upsert_contact(c).expect("Failed to upsert");
        }

        let retrieved = db.get_all_contacts().expect("Failed to get contacts");
        assert_eq!(retrieved.len(), 2);
        
        println!("✅ Retrieved {} contacts", retrieved.len());
        for c in &retrieved {
            println!("  - {} (emails: {:?})", c.name, c.emails);
        }
    }

    #[test]
    #[ignore] // Run with: cargo test test_full_sync -- --ignored --nocapture
    fn test_full_sync_from_apple_contacts() {
        let mut db = AppDb::open(":memory:").expect("Failed to open in-memory database");
        db.init_schema().expect("Failed to create schema");

        println!("\n🔄 Starting full contact sync from Apple Contacts...\n");
        let start = std::time::Instant::now();

        let (synced, before) = db.sync_all_contacts(50, |completed, total| {
            println!("  Progress: {}/{} ({:.0}%)", completed, total,
                (completed as f64 / total as f64) * 100.0);
        }).expect("Failed to sync contacts");

        let elapsed = start.elapsed();
        let total = db.contact_count().expect("Failed to count");
        
        println!("\n✅ Sync complete in {:?}!", elapsed);
        println!("  Contacts before: {}", before);
        println!("  Contacts synced: {}", synced);
        println!("  Total in database: {}", total);

        // Print a few sample contacts
        let contacts = db.get_all_contacts().expect("Failed to get contacts");
        println!("\nSample contacts:");
        for c in contacts.iter().take(10) {
            println!("  - {} | emails: {:?} | phones: {:?}", c.name, c.emails, c.phones);
        }
    }
}