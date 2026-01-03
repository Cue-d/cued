from collections.abc import Generator
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


class MockChat:
    """Mock for core.Chat returned by ChatReader."""

    def __init__(
        self,
        rowid: int,
        chat_identifier: str,
        display_name: str | None,
        is_group: bool,
        last_message_text: str | None,
        last_message_date: int,
    ):
        self.rowid = rowid
        self.chat_identifier = chat_identifier
        self.display_name = display_name
        self.is_group = is_group
        self.last_message_text = last_message_text
        self.last_message_date = last_message_date


class MockHandle:
    """Mock for core.Handle returned by ChatReader."""

    def __init__(self, rowid: int, id: str):
        self.rowid = rowid
        self.id = id


class MockMessage:
    """Mock for core.Message returned by ChatReader."""

    def __init__(
        self,
        rowid: int,
        text: str | None,
        date: int,
        is_from_me: bool,
        is_read: bool,
        date_read: int | None,
        handle_id: int | None,
    ):
        self.rowid = rowid
        self.text = text
        self.date = date
        self.is_from_me = is_from_me
        self.is_read = is_read
        self.date_read = date_read
        self.handle_id = handle_id


class MockSendResult:
    """Mock for core.SendResult returned by send_message."""

    def __init__(self, success: bool, error: str | None = None):
        self.success = success
        self.error = error


@pytest.fixture
def mock_chat_reader() -> MagicMock:
    """Create a mock ChatReader with sample data."""
    reader = MagicMock()

    # Sample chats
    reader.get_all_chats.return_value = [
        MockChat(
            rowid=1,
            chat_identifier="+11234567890",
            display_name=None,
            is_group=False,
            last_message_text="Hello!",
            last_message_date=700000000000000000,  # Apple timestamp
        ),
        MockChat(
            rowid=2,
            chat_identifier="chat123456789",
            display_name="Family Group",
            is_group=True,
            last_message_text="See you tomorrow",
            last_message_date=700000000000000000,
        ),
    ]

    # Sample handles by chat_id
    def get_chat_handles(chat_id: int) -> list[MockHandle]:
        if chat_id == 1:
            return [MockHandle(rowid=1, id="+11234567890")]
        if chat_id == 2:
            return [
                MockHandle(rowid=1, id="+11234567890"),
                MockHandle(rowid=2, id="+10987654321"),
            ]
        return []

    reader.get_chat_handles.side_effect = get_chat_handles

    # All handles
    reader.get_all_handles.return_value = [
        MockHandle(rowid=1, id="+11234567890"),
        MockHandle(rowid=2, id="+10987654321"),
    ]

    # Sample messages
    reader.get_chat_messages.return_value = [
        MockMessage(
            rowid=1,
            text="Hello!",
            date=700000000000000000,
            is_from_me=False,
            is_read=True,
            date_read=700000000000000001,
            handle_id=1,
        ),
        MockMessage(
            rowid=2,
            text="Hi there!",
            date=700000000000000002,
            is_from_me=True,
            is_read=True,
            date_read=None,
            handle_id=None,
        ),
    ]

    return reader


@pytest.fixture
def mock_handle_resolver() -> MagicMock:
    """Create a mock HandleResolver."""
    resolver = MagicMock()

    def resolve(handle: str) -> str | None:
        contacts = {
            "+11234567890": "John Doe",
            "+10987654321": "Jane Smith",
        }
        return contacts.get(handle)

    resolver.resolve.side_effect = resolve
    return resolver


@pytest.fixture
def client(
    mock_chat_reader: MagicMock, mock_handle_resolver: MagicMock
) -> Generator[TestClient, None, None]:
    """Create a test client with mocked dependencies."""
    with (
        patch("routers.conversations.get_chat_reader", return_value=mock_chat_reader),
        patch("routers.conversations.get_handle_resolver", return_value=mock_handle_resolver),
        patch("core.normalize_phone", side_effect=lambda x: x.replace("+", "")),
        patch("core.apple_to_unix", side_effect=lambda x: x // 1000000000),
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
