import os
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from db import AppDb
from services.macos import send_message, send_to_group

router = APIRouter()

PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")

_app_db: AppDb | None = None


def get_app_db() -> AppDb:
    """Get the app database (lazy-loaded singleton)."""
    global _app_db
    if _app_db is None:
        _app_db = AppDb(PRM_DB_PATH)
    return _app_db


class SendMessageRequest(BaseModel):
    text: str


class SendMessageResponse(BaseModel):
    success: bool
    error: str | None = None


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


@router.post("/{chat_id}/messages", response_model=SendMessageResponse)
def send_message_endpoint(chat_id: int, request: SendMessageRequest):
    """Send a message to a chat."""
    db = get_app_db()

    chat = db.get_chat(chat_id)
    if not chat:
        return SendMessageResponse(success=False, error="Chat not found")

    participants = db.get_chat_participants(chat_id)
    if not participants:
        return SendMessageResponse(success=False, error="No recipient found")

    if len(participants) == 1:
        # 1:1 chat - send directly to the handle (phone/email)
        result = send_message(participants[0].identifier, request.text)
    else:
        # Group chat - send using chat identifier (format: chat123456789)
        result = send_to_group(chat.identifier, request.text)

    return SendMessageResponse(success=result.success, error=result.error)
