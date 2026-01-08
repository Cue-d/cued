from datetime import datetime

from fastapi import APIRouter

router = APIRouter()


@router.get("/status")
def get_sync_status():
    """Get sync status - dummy implementation"""
    return {
        "is_syncing": False,
        "last_sync": datetime.now().isoformat(),
        "message_count": 44123,
        "chat_count": 512,
    }
