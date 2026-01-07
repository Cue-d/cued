import os
from collections.abc import Callable

import core
from fastapi import APIRouter

from schemas import (
    AttachmentResponse,
    ChatResponse,
    MessageResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from utils import is_image_mime_type

router = APIRouter()

# Config
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")

# Injected by main.py - triggers background sync
trigger_background_sync: Callable[[], None] | None = None


def get_app_db() -> core.AppDb:
    """Get the app database (source of truth for chats/messages)."""
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    return db


def get_chat_reader() -> core.ChatReader:
    """Get chat reader for sending messages (need to look up chat identifier)."""
    return core.ChatReader(CHAT_DB_PATH)


@router.get("/", response_model=list[ChatResponse])
def get_chats(limit: int = 50, offset: int = 0):
    """Get recent chats from prm.db with pre-resolved names."""
    # Trigger background sync on every poll (debounced in main.py)
    if trigger_background_sync:
        trigger_background_sync()

    db = get_app_db()

    all_chats = db.get_all_chats()
    chats = all_chats[offset : offset + limit]
    result = []

    for chat in chats:
        # Get participants for this chat
        participants = db.get_chat_participants(chat.id)
        member_names = [p.name for p in participants]
        handle_ids = [p.identifier for p in participants]

        # Use stored name or fallback to identifier
        name = chat.name or chat.identifier

        result.append(
            ChatResponse(
                id=chat.id,
                name=name,
                last_message=chat.last_message_text,
                last_message_date=chat.last_message_timestamp,
                is_group=chat.is_group,
                handle_ids=handle_ids,
                member_names=member_names,
            )
        )

    return result


@router.get("/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a chat with pre-resolved sender names and attachments."""
    db = get_app_db()

    # Track that user viewed this chat (for LLM analysis queue)
    db.update_chat_last_viewed(chat_id)

    messages = db.get_chat_messages(chat_id, limit)
    message_ids = [msg.id for msg in messages]

    # Batch fetch attachments for all messages
    attachments_map = db.get_attachments_for_messages(message_ids) if message_ids else {}

    result = []

    for msg in messages:
        # Build attachments list
        msg_attachments = attachments_map.get(msg.id, [])
        attachments = [
            AttachmentResponse(
                id=a.id,
                filename=a.filename,
                mime_type=a.mime_type,
                size=a.size,
                is_image=is_image_mime_type(a.mime_type),
            )
            for a in msg_attachments
        ]

        result.append(
            MessageResponse(
                id=msg.id,
                text=msg.text,
                date=msg.timestamp,
                is_from_me=msg.is_from_me,
                is_read=msg.is_read,
                date_read=msg.read_at,
                sender_name=msg.sender_name,
                is_sent=msg.is_sent,
                is_delivered=msg.is_delivered,
                date_delivered=msg.date_delivered,
                error=msg.error,
                attachments=attachments,
            )
        )

    return result


@router.post("/{chat_id}/messages", response_model=SendMessageResponse)
def send_message(chat_id: int, request: SendMessageRequest):
    """Send a message to a chat."""
    db = get_app_db()

    # Find the chat
    chat = db.get_chat(chat_id)
    if not chat:
        return SendMessageResponse(success=False, error="Chat not found")

    # Get participants to determine if it's a group
    participants = db.get_chat_participants(chat_id)
    if not participants:
        return SendMessageResponse(success=False, error="No recipient found")

    if len(participants) == 1:
        # 1:1 chat - send directly to the handle (phone/email)
        result = core.send_message(participants[0].identifier, request.text)
    else:
        # Group chat - send using chat identifier (format: chat123456789)
        result = core.send_to_group(chat.identifier, request.text)

    return SendMessageResponse(success=result.success, error=result.error)
