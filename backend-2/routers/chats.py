from fastapi import APIRouter
from datetime import datetime

router = APIRouter()


@router.get("/")
def get_chats(limit: int = 50, offset: int = 0):
    """Get recent chats - dummy implementation"""
    return [
        {
            "id": offset + i,
            "chat_identifier": f"+1234567{offset + i:04d}",
            "display_name": f"Contact {offset + i}",
            "last_message_date": datetime.now().isoformat(),
            "last_message_text": f"Last message in chat {offset + i}",
            "unread_count": i % 5,
            "is_group": i % 3 == 0,
            "is_from_me": False,
        }
        for i in range(min(limit, 20))
    ]


@router.get("/{chat_id}/messages")
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a chat - dummy implementation"""
    return [
        {
            "id": chat_id * 1000 + i,
            "chat_id": chat_id,
            "text": f"Message {i} in chat {chat_id}",
            "date": datetime.now().isoformat(),
            "is_from_me": i % 2 == 0,
            "guid": f"msg-{chat_id}-{i}",
            "handle_id": f"+1234567{chat_id:04d}",
            "service": "iMessage",
            "associated_message_guid": None,
            "associated_message_type": 0,
            "attachments": [],
            "reactions": [],
        }
        for i in range(min(limit, 10))
    ]


@router.post("/{chat_id}/messages")
def send_message(chat_id: int, payload: dict):
    """Send a message - dummy implementation"""
    return {
        "success": True,
        "message_id": 99999,
        "text": payload.get("text", ""),
        "chat_id": chat_id,
    }
