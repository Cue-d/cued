import os
import time

from fastapi import APIRouter
from pydantic import BaseModel

from db import AppDb

router = APIRouter()

PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")

_app_db: AppDb | None = None


def get_app_db() -> AppDb:
    """Get the app database (lazy-loaded singleton)."""
    global _app_db
    if _app_db is None:
        _app_db = AppDb(PRM_DB_PATH)
    return _app_db


class SyncStatusResponse(BaseModel):
    is_syncing: bool
    initial_sync_complete: bool
    last_sync_at: int | None = None
    last_sync_duration: int | None = None
    last_error: str | None = None


@router.get("/status", response_model=SyncStatusResponse)
def get_sync_status():
    """Get sync status based on whether we have cached messages."""
    db = get_app_db()

    try:
        # Check text cache count instead of chats (we now read chats from chat.db)
        cache_count = db.get_cache_count()
        has_data = cache_count > 0

        return SyncStatusResponse(
            is_syncing=False,
            initial_sync_complete=has_data,
            last_sync_at=int(time.time()) if has_data else None,
            last_sync_duration=None,
            last_error=None,
        )
    except Exception as e:
        return SyncStatusResponse(
            is_syncing=False,
            initial_sync_complete=False,
            last_sync_at=None,
            last_sync_duration=None,
            last_error=str(e),
        )
