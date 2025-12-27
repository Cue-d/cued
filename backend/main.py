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
    member_names: list[str]  # Resolved names for group avatars


class MessageResponse(BaseModel):
    id: int
    text: str | None
    date: int
    is_from_me: bool
    sender_name: str | None


def strip_country_code(phone: str) -> str:
    """Strip leading country code (1 for US) from normalized phone number."""
    if len(phone) == 11 and phone.startswith('1'):
        return phone[1:]
    return phone


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
                            # Store both with and without country code
                            self._lookup[normalized] = contact.name
                            stripped = strip_country_code(normalized)
                            if stripped != normalized:
                                self._lookup[stripped] = contact.name
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

        # Try without country code
        stripped = strip_country_code(normalized_phone)
        if stripped in self._lookup:
            return self._lookup[stripped]

        # Try as email
        normalized_email = core.normalize_email(handle_id)
        if normalized_email in self._lookup:
            return self._lookup[normalized_email]

        return None


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

        result.append(ConversationResponse(
            id=chat.rowid,
            name=name,
            last_message=chat.last_message_text,
            last_message_date=core.apple_to_unix(chat.last_message_date),
            is_group=chat.is_group,
            handle_ids=handle_ids,
            member_names=member_names,
        ))

    return result


@app.get("/conversations/{chat_id}/messages", response_model=list[MessageResponse])
def get_messages(chat_id: int, limit: int = 100):
    """Get messages for a conversation with resolved sender names."""
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
