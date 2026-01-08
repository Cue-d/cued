"""Chats router - chat and message endpoints.

Reads directly from chat.db via ChatDb.
"""

import os

from fastapi import APIRouter
from pydantic import BaseModel

from db.chat_db import ChatDb
from services.macos import send_message, send_to_group

router = APIRouter()

CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")

_chat_db: ChatDb | None = None


def get_chat_db() -> ChatDb:
    """Get the chat database (lazy-loaded singleton)."""
    global _chat_db
    if _chat_db is None:
        _chat_db = ChatDb(CHAT_DB_PATH)
    return _chat_db


class SendMessageRequest(BaseModel):
    text: str


class SendMessageResponse(BaseModel):
    success: bool
    error: str | None = None


class AttachmentResponse(BaseModel):
    id: int
    filename: str | None = None
    mime_type: str | None = None
    size: int | None = None
    is_image: bool = False


class MessageResponse(BaseModel):
    id: int
    text: str | None = None
    date: int  # Unix timestamp in seconds
    is_from_me: bool
    is_read: bool
    date_read: int | None = None
    sender_name: str | None = None
    # Delivery status fields - always provide defaults for outgoing messages
    is_sent: bool = True
    is_delivered: bool = False
    date_delivered: int | None = None
    error: int = 0
    attachments: list[AttachmentResponse] = []


class ChatResponse(BaseModel):
    id: int
    name: str
    last_message: str | None = None
    last_message_date: int  # Unix timestamp in seconds
    is_group: bool
    handle_ids: list[str] = []
    member_names: list[str] = []


@router.get("/", response_model=list[ChatResponse])
def get_chats(limit: int = 50, offset: int = 0):
    """Get recent chats with last message preview."""
    db = get_chat_db()
    all_chats = db.get_all_chats()

    # Apply pagination
    paginated = all_chats[offset : offset + limit]

    result = []
    for chat in paginated:
        # Get participants for this chat
        participants = db.get_chat_participants(chat.id)
        handle_ids = [p["identifier"] for p in participants]

        # Compute display name: use chat.name if set, otherwise use first participant
        name = chat.name
        if not name:
            if handle_ids:
                name = handle_ids[0]  # Use first participant as name
            else:
                name = chat.identifier

        result.append(
            ChatResponse(
                id=chat.id,
                name=name,
                last_message=chat.last_message_text,
                last_message_date=chat.last_message_timestamp or 0,
                is_group=chat.is_group,
                handle_ids=handle_ids,
                member_names=handle_ids,  # Use identifiers as member names for now
            )
        )

    return result


@router.get("/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a chat with sender info."""
    db = get_chat_db()
    messages = db.get_chat_messages(chat_id, limit)

    result = []
    for msg in messages:
        # Get attachments for this message if it has any
        attachments = []
        if msg.has_attachments:
            db_attachments = db.get_message_attachments(msg.id)
            attachments = [
                AttachmentResponse(
                    id=att["id"],
                    filename=att["filename"],
                    mime_type=att["mime_type"],
                    size=att["size"],
                    is_image=att["mime_type"].startswith("image/") if att["mime_type"] else False,
                )
                for att in db_attachments
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
                # For outgoing messages, assume sent and delivered
                is_sent=True,
                is_delivered=msg.is_from_me,  # Assume delivered if from me
                date_delivered=msg.timestamp if msg.is_from_me else None,
                error=0,
                attachments=attachments,
            )
        )

    return result


@router.get("/{chat_id}/participants")
def get_chat_participants(chat_id: int):
    """Get participants for a chat."""
    db = get_chat_db()
    participants = db.get_chat_participants(chat_id)
    return participants


@router.post("/{chat_id}/messages", response_model=SendMessageResponse)
def send_message_endpoint(chat_id: int, request: SendMessageRequest):
    """Send a message to a chat."""
    db = get_chat_db()

    chat = db.get_chat(chat_id)
    if not chat:
        return SendMessageResponse(success=False, error="Chat not found")

    participants = db.get_chat_participants(chat_id)
    if not participants:
        return SendMessageResponse(success=False, error="No recipient found")

    if len(participants) == 1:
        # 1:1 chat - send directly to the handle (phone/email)
        result = send_message(participants[0]["identifier"], request.text)
    else:
        # Group chat - send using chat identifier (format: chat123456789)
        result = send_to_group(chat.identifier, request.text)

    return SendMessageResponse(success=result.success, error=result.error)
