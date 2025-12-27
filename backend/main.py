import os
import json
from fastapi import FastAPI
from pydantic import BaseModel
import core

app = FastAPI()

# Config
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")


# Pydantic models for API responses
class ConversationResponse(BaseModel):
    id: int
    name: str
    last_message: str | None
    last_message_date: int
    is_group: bool
    handle_ids: list[str]


class MessageResponse(BaseModel):
    id: int
    text: str | None
    date: int
    is_from_me: bool
    sender_name: str | None


class HandleResolver:
    """Resolves handles (phone/email) to contact names."""

    def __init__(self, app_db_path: str):
        self._lookup: dict[str, str] = {}
        self._build_lookup(app_db_path)

    def _build_lookup(self, app_db_path: str):
        """Build a normalized phone/email -> contact name lookup."""
        if not os.path.exists(app_db_path):
            return

        db = core.AppDb(app_db_path)
        contacts = db.get_all_contacts()

        for contact in contacts:
            # Parse phones JSON array
            if contact.phones:
                try:
                    phones = json.loads(contact.phones)
                    for phone in phones:
                        normalized = core.normalize_phone(phone)
                        if normalized:
                            self._lookup[normalized] = contact.name
                except json.JSONDecodeError:
                    pass

            # Parse emails JSON array
            if contact.emails:
                try:
                    emails = json.loads(contact.emails)
                    for email in emails:
                        normalized = core.normalize_email(email)
                        if normalized:
                            self._lookup[normalized] = contact.name
                except json.JSONDecodeError:
                    pass

    def resolve(self, handle_id: str) -> str | None:
        """Resolve a handle ID to a contact name."""
        # Try as phone number
        normalized_phone = core.normalize_phone(handle_id)
        if normalized_phone in self._lookup:
            return self._lookup[normalized_phone]

        # Try as email
        normalized_email = core.normalize_email(handle_id)
        if normalized_email in self._lookup:
            return self._lookup[normalized_email]

        return None


# Global instances (lazy init)
_chat_reader: core.ChatReader | None = None
_handle_resolver: HandleResolver | None = None
_handle_map: dict[int, str] = {}  # rowid -> handle_id


def get_chat_reader() -> core.ChatReader:
    global _chat_reader
    if _chat_reader is None:
        _chat_reader = core.ChatReader(CHAT_DB_PATH)
    return _chat_reader


def get_handle_resolver() -> HandleResolver:
    global _handle_resolver
    if _handle_resolver is None:
        _handle_resolver = HandleResolver(APP_DB_PATH)
    return _handle_resolver


def get_handle_map() -> dict[int, str]:
    global _handle_map
    if not _handle_map:
        reader = get_chat_reader()
        handles = reader.get_all_handles()
        _handle_map = {h.rowid: h.id for h in handles}
    return _handle_map


@app.get("/")
def root():
    return {"message": "PRM API"}


@app.get("/conversations", response_model=list[ConversationResponse])
def get_conversations(limit: int = 50):
    """Get recent conversations with resolved contact names."""
    reader = get_chat_reader()
    resolver = get_handle_resolver()

    chats = reader.get_all_chats()[:limit]
    result = []

    for chat in chats:
        # Get handles for this chat
        handles = reader.get_chat_handles(chat.rowid)
        handle_ids = [h.id for h in handles]

        # Resolve name: use display_name, or resolved contact, or raw identifier
        # For 1:1 chats (single handle), try to resolve to contact name
        name = chat.display_name
        if not name and len(handle_ids) == 1:
            name = resolver.resolve(handle_ids[0])
        if not name:
            # Fall back to chat_identifier, but try to resolve it too
            name = resolver.resolve(chat.chat_identifier) or chat.chat_identifier

        result.append(ConversationResponse(
            id=chat.rowid,
            name=name,
            last_message=chat.last_message_text,
            last_message_date=core.apple_to_unix(chat.last_message_date),
            is_group=chat.is_group,
            handle_ids=handle_ids,
        ))

    return result


@app.get("/conversations/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a conversation with resolved sender names."""
    reader = get_chat_reader()
    resolver = get_handle_resolver()
    handle_map = get_handle_map()

    messages = reader.get_chat_messages(chat_id, limit)
    result = []

    for msg in messages:
        sender_name = None
        if not msg.is_from_me and msg.handle_id:
            handle_id = handle_map.get(msg.handle_id)
            if handle_id:
                sender_name = resolver.resolve(handle_id)

        result.append(MessageResponse(
            id=msg.rowid,
            text=msg.text,
            date=core.apple_to_unix(msg.date),
            is_from_me=msg.is_from_me,
            sender_name=sender_name,
        ))

    return result


@app.get("/test/normalize-phone/{phone}")
def normalize_phone(phone: str):
    return {"original": phone, "normalized": core.normalize_phone(phone)}
