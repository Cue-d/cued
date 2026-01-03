from collections.abc import Generator
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


class MockPrmChat:
    """Mock for core.PrmChat returned by AppDb."""

    def __init__(
        self,
        id: int,
        identifier: str,
        display_name: str | None,
        computed_name: str | None,
        is_group: bool,
        last_message_text: str | None,
        last_message_timestamp: int | None,
    ):
        self.id = id
        self.identifier = identifier
        self.display_name = display_name
        self.computed_name = computed_name
        self.is_group = is_group
        self.last_message_text = last_message_text
        self.last_message_timestamp = last_message_timestamp


class MockPerson:
    """Mock for core.Person returned by AppDb."""

    def __init__(self, id: int, identifier: str, name: str, short_name: str | None = None):
        self.id = id
        self.identifier = identifier
        self.name = name
        self.short_name = short_name or name.split()[0]
        self.service = "iMessage"
        self.is_contact = True
        self.contact_phones = None
        self.contact_emails = None
        self.company = None
        self.notes = None


class MockPrmMessage:
    """Mock for core.PrmMessage returned by AppDb."""

    def __init__(
        self,
        id: int,
        chat_id: int,
        sender_id: int | None,
        sender_name: str | None,
        text: str | None,
        timestamp: int,
        is_from_me: bool,
        is_read: bool,
        read_at: int | None,
        has_attachments: bool = False,
    ):
        self.id = id
        self.chat_id = chat_id
        self.sender_id = sender_id
        self.sender_name = sender_name
        self.text = text
        self.timestamp = timestamp
        self.is_from_me = is_from_me
        self.is_read = is_read
        self.read_at = read_at
        self.has_attachments = has_attachments


class MockSendResult:
    """Mock for core.SendResult returned by send_message."""

    def __init__(self, success: bool, error: str | None = None):
        self.success = success
        self.error = error


@pytest.fixture
def mock_app_db() -> MagicMock:
    """Create a mock AppDb with sample data."""
    db = MagicMock()

    # Sample chats
    db.get_all_chats.return_value = [
        MockPrmChat(
            id=1,
            identifier="+11234567890",
            display_name=None,
            computed_name="John Doe",
            is_group=False,
            last_message_text="Hello!",
            last_message_timestamp=700000000,  # Unix timestamp
        ),
        MockPrmChat(
            id=2,
            identifier="chat123456789",
            display_name="Family Group",
            computed_name="Family Group",
            is_group=True,
            last_message_text="See you tomorrow",
            last_message_timestamp=700000000,
        ),
    ]

    # Sample participants by chat_id
    def get_chat_participants(chat_id: int) -> list[MockPerson]:
        if chat_id == 1:
            return [MockPerson(id=1, identifier="+11234567890", name="John Doe")]
        if chat_id == 2:
            return [
                MockPerson(id=1, identifier="+11234567890", name="John Doe"),
                MockPerson(id=2, identifier="+10987654321", name="Jane Smith"),
            ]
        return []

    db.get_chat_participants.side_effect = get_chat_participants

    # Get single chat
    def get_chat(chat_id: int) -> MockPrmChat | None:
        chats = {
            1: MockPrmChat(
                id=1,
                identifier="+11234567890",
                display_name=None,
                computed_name="John Doe",
                is_group=False,
                last_message_text="Hello!",
                last_message_timestamp=700000000,
            ),
            2: MockPrmChat(
                id=2,
                identifier="chat123456789",
                display_name="Family Group",
                computed_name="Family Group",
                is_group=True,
                last_message_text="See you tomorrow",
                last_message_timestamp=700000000,
            ),
        }
        return chats.get(chat_id)

    db.get_chat.side_effect = get_chat

    # Sample messages
    db.get_chat_messages.return_value = [
        MockPrmMessage(
            id=1,
            chat_id=1,
            sender_id=1,
            sender_name="John Doe",
            text="Hello!",
            timestamp=700000000,
            is_from_me=False,
            is_read=True,
            read_at=700000001,
        ),
        MockPrmMessage(
            id=2,
            chat_id=1,
            sender_id=None,
            sender_name=None,
            text="Hi there!",
            timestamp=700000002,
            is_from_me=True,
            is_read=True,
            read_at=None,
        ),
    ]

    return db


@pytest.fixture
def client(mock_app_db: MagicMock) -> Generator[TestClient, None, None]:
    """Create a test client with mocked dependencies."""
    with (
        patch("routers.chats.get_app_db", return_value=mock_app_db),
        patch("routers.chats.trigger_background_sync", None),
        patch("main.run_sync"),  # Skip sync on startup
        patch("main.has_existing_data", return_value=True),  # Pretend data exists
        patch("main.trigger_background_sync"),  # Don't trigger background sync
        patch("core.normalize_phone", side_effect=lambda x: x.replace("+", "")),
        patch(
            "core.send_message",
            return_value=MockSendResult(success=True),
        ),
        patch(
            "core.send_to_group",
            return_value=MockSendResult(success=True),
        ),
    ):
        from main import app

        yield TestClient(app)
