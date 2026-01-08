"""Contacts sync router - syncs contacts from Apple Contacts to prm.db."""

import logging
import time

from fastapi import APIRouter
from pydantic import BaseModel

from deps import get_app_db
from services.macos.contacts import fetch_all_contact_names, fetch_contacts_by_names

router = APIRouter()
logger = logging.getLogger(__name__)


class ContactsSyncStatus(BaseModel):
    has_synced: bool
    last_sync_at: int | None = None
    total_contacts: int = 0
    total_handles: int = 0


class ContactsStats(BaseModel):
    active: int = 0
    deleted: int = 0
    total: int = 0


class SyncResult(BaseModel):
    success: bool
    message: str
    contacts_added: int = 0
    skipped_no_handles: int = 0


@router.get("/status", response_model=ContactsSyncStatus)
def get_contacts_status():
    """Get contacts sync status."""
    db = get_app_db()
    last_sync = db.get_contacts_last_sync()
    counts = db.get_contact_count()
    handle_count = db.get_handle_count()

    return ContactsSyncStatus(
        has_synced=last_sync is not None,
        last_sync_at=last_sync,
        total_contacts=counts["total"],
        total_handles=handle_count,
    )


@router.post("/sync", response_model=SyncResult)
def sync_contacts_full():
    """Full contacts sync from Apple Contacts.

    Clears all existing contacts and re-syncs from Apple Contacts.
    Uses a transaction to ensure atomic updates.
    """
    db = get_app_db()

    try:
        # Fetch all contact names from Apple Contacts
        logger.info("Fetching contact names from Apple Contacts...")
        names = fetch_all_contact_names()
        logger.info(f"Found {len(names)} contacts in Apple Contacts")

        if not names:
            db.set_contacts_last_sync(int(time.time()))
            return SyncResult(
                success=True,
                message="No contacts found in Apple Contacts",
                contacts_added=0,
                skipped_no_handles=0,
            )

        # Fetch full contact details in batches
        batch_size = 50
        all_contacts = []
        for i in range(0, len(names), batch_size):
            batch_names = names[i : i + batch_size]
            logger.debug(f"Fetching batch {i // batch_size + 1}: {len(batch_names)} contacts")
            contacts = fetch_contacts_by_names(batch_names)
            all_contacts.extend(contacts)

        logger.info(f"Fetched details for {len(all_contacts)} contacts")

        # Sync within a transaction for atomicity
        added = 0
        skipped = 0

        with db.transaction() as session:
            # Clear existing contacts
            db.clear_all_contacts_in_transaction(session)

            # Insert all contacts with handles
            for contact in all_contacts:
                if contact.phones or contact.emails:
                    db.insert_contact_in_transaction(
                        session,
                        name=contact.name,
                        phones=contact.phones,
                        emails=contact.emails,
                        company=contact.company,
                        notes=contact.notes,
                    )
                    added += 1
                else:
                    skipped += 1

        # Update sync timestamp (outside transaction - separate commit)
        db.set_contacts_last_sync(int(time.time()))

        logger.info(f"Contacts sync complete: {added} added, {skipped} skipped (no handles)")
        return SyncResult(
            success=True,
            message=f"Synced {added} contacts from Apple Contacts",
            contacts_added=added,
            skipped_no_handles=skipped,
        )

    except Exception as e:
        logger.error(f"Contacts sync failed: {e}", exc_info=True)
        return SyncResult(
            success=False,
            message=f"Sync failed: {str(e)}",
            contacts_added=0,
            skipped_no_handles=0,
        )


@router.get("/stats", response_model=ContactsStats)
def get_contacts_stats():
    """Get contact counts."""
    db = get_app_db()
    counts = db.get_contact_count()
    return ContactsStats(
        active=counts["active"],
        deleted=counts["deleted"],
        total=counts["total"],
    )
