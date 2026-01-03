import os

import core
from fastapi import APIRouter

from schemas import (
    ChatResponse,
    MessageResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from services import HandleResolver

router = APIRouter()

# Config
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")

# Global resolver (thread-safe since it's just a dict)
_handle_resolver: HandleResolver | None = None


def get_chat_reader() -> core.ChatReader:
    """Create a new ChatReader for each request (SQLite connections are not thread-safe)."""
    return core.ChatReader(CHAT_DB_PATH)


def get_handle_resolver() -> HandleResolver:
    global _handle_resolver
    if _handle_resolver is None:
        _handle_resolver = HandleResolver(APP_DB_PATH)
    return _handle_resolver


def get_handle_map(reader: core.ChatReader) -> dict[int, str]:
    """Build handle map from reader."""
    handles = reader.get_all_handles()
    return {h.rowid: h.id for h in handles}


@router.get("/", response_model=list[ChatResponse])
def get_chats(limit: int = 50, offset: int = 0):
    """Get recent chats with resolved contact names."""
    reader = get_chat_reader()
    resolver = get_handle_resolver()

    all_chats = reader.get_all_chats()
    chats = all_chats[offset : offset + limit]
    result = []

    for chat in chats:
        # Get handles for this chat
        handles = reader.get_chat_handles(chat.rowid)
        handle_ids = [h.id for h in handles]

        # Resolve each handle to full name (for member_names)
        member_names = []
        for hid in handle_ids:
            resolved = resolver.resolve(hid)
            if resolved:
                member_names.append(resolved)
            else:
                # Use last 4 digits of phone as fallback
                digits = core.normalize_phone(hid)
                member_names.append(digits[-4:] if len(digits) >= 4 else hid)

        # Resolve display name based on chat type
        name = chat.display_name
        if not name:
            if len(handle_ids) == 1:
                # 1:1 chat - use full resolved name
                name = member_names[0] if member_names else handle_ids[0]
            elif len(handle_ids) > 1:
                # Group chat - use first names only
                first_names = [n.split()[0] for n in member_names[:4]]
                name = ", ".join(first_names)
                if len(handle_ids) > 4:
                    name += f" +{len(handle_ids) - 4}"
            else:
                name = chat.chat_identifier

        result.append(
            ChatResponse(
                id=chat.rowid,
                name=name,
                last_message=chat.last_message_text,
                last_message_date=core.apple_to_unix(chat.last_message_date),
                is_group=chat.is_group,
                handle_ids=handle_ids,
                member_names=member_names,
            )
        )

    return result


@router.get("/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a chat with resolved sender names."""
    reader = get_chat_reader()
    resolver = get_handle_resolver()
    handle_map = get_handle_map(reader)

    messages = reader.get_chat_messages(chat_id, limit)
    result = []

    for msg in messages:
        sender_name = None
        if not msg.is_from_me and msg.handle_id:
            handle_id = handle_map.get(msg.handle_id)
            if handle_id:
                sender_name = resolver.resolve(handle_id)

        # Convert date_read from Apple timestamp to Unix timestamp if present
        date_read_unix = None
        if msg.date_read is not None:
            date_read_unix = core.apple_to_unix(msg.date_read)

        result.append(
            MessageResponse(
                id=msg.rowid,
                text=msg.text,
                date=core.apple_to_unix(msg.date),
                is_from_me=msg.is_from_me,
                is_read=msg.is_read,
                date_read=date_read_unix,
                sender_name=sender_name,
            )
        )

    return result


@router.post("/{chat_id}/messages", response_model=SendMessageResponse)
def send_message(chat_id: int, request: SendMessageRequest):
    """Send a message to a chat."""
    reader = get_chat_reader()

    # Find the chat
    chats = reader.get_all_chats()
    chat = next((c for c in chats if c.rowid == chat_id), None)

    if not chat:
        return SendMessageResponse(success=False, error="Chat not found")

    # Get handles to determine if it's truly a group chat
    handles = reader.get_chat_handles(chat_id)
    if not handles:
        return SendMessageResponse(success=False, error="No recipient found")

    if len(handles) == 1:
        # 1:1 chat - send directly to the handle (phone/email)
        result = core.send_message(handles[0].id, request.text)
    else:
        # Group chat - send using chat identifier (format: chat123456789)
        result = core.send_to_group(chat.chat_identifier, request.text)

    return SendMessageResponse(success=result.success, error=result.error)
