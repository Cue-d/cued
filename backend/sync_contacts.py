"""
Sync contacts from Apple Contacts to prm.db.

This is the orchestration layer - Rust core provides dumb data access,
Python handles the workflow, batching, progress, and error handling.
"""

import os
import time
import core

# Config
DB_PATH = os.path.expanduser("~/.prm/prm.db")
BATCH_SIZE = 50


def sync_contacts():
    """Sync all contacts from Apple Contacts to prm.db."""

    # Ensure directory exists
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    # Open database and init schema
    db = core.AppDb(DB_PATH)
    db.init_schema()

    before_count = db.contact_count()
    print(f"Contacts in DB before sync: {before_count}")

    # Step 1: Fetch all contact names from Apple Contacts
    print("\nFetching contact names from Apple Contacts...")
    start = time.time()
    names = core.fetch_all_contact_names()
    print(f"Found {len(names)} contacts in {time.time() - start:.1f}s")

    if not names:
        print("No contacts found.")
        return

    # Step 2: Fetch details in batches and upsert
    print(f"\nFetching details in batches of {BATCH_SIZE}...")
    total_synced = 0
    start = time.time()

    for i in range(0, len(names), BATCH_SIZE):
        batch = names[i:i + BATCH_SIZE]

        try:
            contacts = core.fetch_contacts_by_names(batch)
            synced = db.upsert_contacts(contacts)
            total_synced += synced

            progress = min(i + BATCH_SIZE, len(names))
            pct = (progress / len(names)) * 100
            print(f"  Progress: {progress}/{len(names)} ({pct:.0f}%) - batch synced {synced}")

        except Exception as e:
            print(f"  Error in batch {i//BATCH_SIZE}: {e}")

    elapsed = time.time() - start
    after_count = db.contact_count()

    print(f"\nSync complete in {elapsed:.1f}s")
    print(f"  Contacts synced: {total_synced}")
    print(f"  Contacts in DB: {after_count}")
    print(f"  New contacts: {after_count - before_count}")


if __name__ == "__main__":
    sync_contacts()
