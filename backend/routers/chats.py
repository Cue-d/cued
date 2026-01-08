"""Chats router - chat and message endpoints.

Reads directly from chat.db via ChatDb, with contact name resolution from prm.db.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from deps import get_app_db, get_chat_db
from services.contacts import ContactResolver, get_chat_display_name
from services.macos import send_message, send_to_group

router = APIRouter()


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
    resolver = ContactResolver(get_app_db())
    all_chats = db.get_all_chats()

    # Apply pagination
    paginated = all_chats[offset : offset + limit]

    # Collect all handles for batch lookup
    all_handles = set()
    chat_participants = {}
    for chat in paginated:
        participants = db.get_chat_participants(chat.id)
        handle_ids = [p["identifier"] for p in participants]
        chat_participants[chat.id] = handle_ids
        all_handles.update(handle_ids)

    # Batch lookup contact names
    handle_to_name = resolver.resolve_handles(list(all_handles))

    result = []
    for chat in paginated:
        handle_ids = chat_participants[chat.id]
        member_names = [handle_to_name.get(h, h) for h in handle_ids]
        name = get_chat_display_name(chat, handle_to_name, handle_ids)

        result.append(
            ChatResponse(
                id=chat.id,
                name=name,
                last_message=chat.last_message_text,
                last_message_date=chat.last_message_timestamp or 0,
                is_group=chat.is_group,
                handle_ids=handle_ids,
                member_names=member_names,
            )
        )

    return result


@router.get("/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a chat with sender info."""
    db = get_chat_db()
    resolver = ContactResolver(get_app_db())
    messages = db.get_chat_messages(chat_id, limit)

    # Batch resolve sender names
    handle_to_name = resolver.resolve_sender_names(messages)

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

        # Resolve sender name from contacts
        sender_name = msg.sender_name
        if sender_name and not msg.is_from_me:
            sender_name = handle_to_name.get(msg.sender_name, msg.sender_name)

        result.append(
            MessageResponse(
                id=msg.id,
                text=msg.text,
                date=msg.timestamp,
                is_from_me=msg.is_from_me,
                is_read=msg.is_read,
                date_read=msg.read_at,
                sender_name=sender_name,
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
