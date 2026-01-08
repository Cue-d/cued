import time

from fastapi import APIRouter
from pydantic import BaseModel

from dependencies import get_app_db

router = APIRouter()


class SyncStatusResponse(BaseModel):
    is_syncing: bool
    initial_sync_complete: bool
    last_sync_at: int | None = None
    last_sync_duration: int | None = None
    last_error: str | None = None


@router.get("/status", response_model=SyncStatusResponse)
def get_sync_status():
    """Get sync status based on whether we have data."""
    # Check if we have any data in the database
    db = get_app_db()

    try:
        chats = db.get_all_chats()
        has_data = len(chats) > 0

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
