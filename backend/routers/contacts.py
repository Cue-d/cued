"""Contacts sync router - syncs contacts from Apple Contacts to prm.db."""

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from deps import get_app_db
from services.contacts_sync import sync_contacts_to_db

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
    Uses Swift CLI with Contacts.framework for fast retrieval.
    Uses a transaction to ensure atomic updates.
    """
    db = get_app_db()
    result = sync_contacts_to_db(db)

    if result.success:
        logger.info(
            f"Contacts sync complete: {result.contacts_added} contacts "
            f"(fetch: {result.fetch_time_seconds:.3f}s, "
            f"db: {result.db_time_seconds:.3f}s, "
            f"total: {result.total_time_seconds:.3f}s)"
        )
    else:
        logger.error(f"Contacts sync failed: {result.message}")

    return SyncResult(
        success=result.success,
        message=result.message,
        contacts_added=result.contacts_added,
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
