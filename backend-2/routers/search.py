from fastapi import APIRouter, Query
from datetime import datetime

router = APIRouter()


@router.get("/")
def search_messages(query: str = Query(...), limit: int = 50):
    """Search messages - dummy implementation"""
    return [
        {
            "chat_id": i,
            "message_id": i * 100,
            "text": f"Search result {i} matching '{query}'",
            "date": datetime.now().isoformat(),
            "display_name": f"Contact {i}",
            "rank": 1.0 - (i * 0.05),
        }
        for i in range(min(limit, 8))
    ]
