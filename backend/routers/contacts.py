"""Contacts sync router - stub implementation.

These endpoints return stub data until full contact sync is implemented.
The frontend can still function without real contact data.
"""

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class ContactsSyncStatus(BaseModel):
    has_synced: bool
    last_sync_at: int | None = None
    total_contacts: int = 0
    total_handles: int = 0


class ContactsStats(BaseModel):
    active: int = 0
    deleted: int = 0
    total: int = 0


@router.get("/status", response_model=ContactsSyncStatus)
def get_contacts_status():
    """Get contacts sync status - stub returns no sync data."""
    return ContactsSyncStatus(
        has_synced=False,
        last_sync_at=None,
        total_contacts=0,
        total_handles=0,
    )


@router.post("/sync")
def sync_contacts():
    """Trigger incremental contacts sync - stub does nothing."""
    return {
        "success": True,
        "message": "Contacts sync not yet implemented",
        "contacts_added": 0,
        "contacts_updated": 0,
    }


@router.post("/sync/full")
def sync_contacts_full():
    """Force full contacts sync - stub does nothing."""
    return {
        "success": True,
        "message": "Contacts sync not yet implemented",
        "contacts_added": 0,
        "contacts_updated": 0,
    }


@router.get("/stats", response_model=ContactsStats)
def get_contacts_stats():
    """Get contact counts - stub returns zeros."""
    return ContactsStats(
        active=0,
        deleted=0,
        total=0,
    )
