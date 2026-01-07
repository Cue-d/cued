"""
Contacts API router.

Provides endpoints for managing Apple Contacts sync.
"""

import core
from fastapi import APIRouter

from contact_sync import (
    get_sync_status,
    sync_contacts,
    sync_contacts_full,
)
from sync_db import APP_DB_PATH

router = APIRouter(tags=["contacts"])


def get_db():
    """Get app database connection.

    Note: Schema is initialized at app startup via sync_all(), so we don't
    need to call init_schema() here. SQLite tables use IF NOT EXISTS anyway.
    """
    return core.AppDb(APP_DB_PATH)


@router.get("/status")
def get_contacts_sync_status() -> dict:
    """
    Get the current status of the contacts sync engine.

    Returns:
        - total_contacts: Number of active contacts in the database
        - deleted_contacts: Number of contacts marked as deleted
        - last_sync_timestamp: Unix timestamp of the last sync
        - last_modification_timestamp: Latest modification timestamp from Apple Contacts
    """
    db = get_db()
    status = get_sync_status(db)
    return status.to_dict()


@router.post("/sync")
def trigger_contacts_sync(force_full: bool = False) -> dict:
    """
    Trigger a contacts sync.

    Args:
        force_full: If True, perform a full sync even if incremental is possible

    Returns:
        - synced: Number of contacts processed
        - created: Number of new contacts
        - updated: Number of updated contacts
        - deleted: Number of contacts marked as deleted
        - duration_seconds: Time taken for the sync
        - is_full_sync: Whether this was a full or incremental sync
    """
    db = get_db()
    result = sync_contacts(db, force_full=force_full, verbose=True)
    return result.to_dict()


@router.post("/sync/full")
def trigger_full_contacts_sync() -> dict:
    """
    Force a full contacts sync.

    This fetches all contacts from Apple Contacts and refreshes the database.
    Use this when you suspect the database is out of sync.
    """
    db = get_db()
    result = sync_contacts_full(db, verbose=True)
    return result.to_dict()


@router.get("/stats")
def get_contacts_stats() -> dict:
    """
    Get statistics about synced contacts.

    Returns:
        - active: Number of active contacts
        - deleted: Number of deleted contacts
        - total: Total contacts (active + deleted)
    """
    db = get_db()
    active, deleted = db.get_contact_stats()
    return {
        "active": active,
        "deleted": deleted,
        "total": active + deleted,
    }
