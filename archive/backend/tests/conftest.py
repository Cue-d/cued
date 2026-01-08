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
        name: str | None,
        is_group: bool,
        last_message_text: str | None,
        last_message_timestamp: int | None,
    ):
        self.id = id
        self.identifier = identifier
        self.name = name
        self.is_group = is_group
        self.last_message_text = last_message_text
        self.last_message_timestamp = last_message_timestamp


class MockPerson:
    """Mock for core.Person returned by AppDb."""

    def __init__(
        self,
        id: int,
        identifier: str,
        name: str,
        contact_id: int | None = None,
    ):
        self.id = id
        self.identifier = identifier
        self.name = name
        self.service = "iMessage"
        self.is_contact = True
        self.contact_id = contact_id
        self.phones = None
        self.emails = None
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
        is_sent: bool = True,
        is_delivered: bool = True,
        date_delivered: int | None = None,
        error: int = 0,
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
        self.is_sent = is_sent
        self.is_delivered = is_delivered
        self.date_delivered = date_delivered
        self.error = error


class MockSendResult:
    """Mock for core.SendResult returned by send_message."""

    def __init__(self, success: bool, error: str | None = None):
        self.success = success
        self.error = error


class MockAction:
    """Mock for core.Action returned by AppDb."""

    def __init__(
        self,
        id: int,
        action_type: str,
        status: str = "pending",
        priority: int = 50,
        chat_id: int | None = None,
        person_id: int | None = None,
        message_id: int | None = None,
        payload: str | None = None,
        created_at: int = 700000000,
        remind_at: int | None = None,
        snoozed_until: int | None = None,
        completed_at: int | None = None,
        discarded_at: int | None = None,
        chat_name: str | None = None,
        person_name: str | None = None,
        message_text: str | None = None,
        message_timestamp: int | None = None,
    ):
        self.id = id
        self.action_type = action_type
        self.status = status
        self.priority = priority
        self.chat_id = chat_id
        self.person_id = person_id
        self.message_id = message_id
        self.payload = payload
        self.created_at = created_at
        self.remind_at = remind_at
        self.snoozed_until = snoozed_until
        self.completed_at = completed_at
        self.discarded_at = discarded_at
        self.chat_name = chat_name
        self.person_name = person_name
        self.message_text = message_text
        self.message_timestamp = message_timestamp


class MockUnansweredChat:
    """Mock for core.UnansweredChat returned by get_unanswered_chats."""

    def __init__(
        self,
        message_id: int,
        chat_id: int,
        sender_id: int | None,
        text: str | None,
        timestamp: int,
        chat_name: str | None,
        person_name: str | None,
        hours_since: int,
    ):
        self.message_id = message_id
        self.chat_id = chat_id
        self.sender_id = sender_id
        self.text = text
        self.timestamp = timestamp
        self.chat_name = chat_name
        self.person_name = person_name
        self.hours_since = hours_since


class MockSearchResult:
    """Mock for core.SearchResult returned by search_messages."""

    def __init__(
        self,
        message_id: int,
        chat_id: int,
        text: str,
        timestamp: int,
        sender_name: str | None,
        chat_name: str | None,
        rank: float,
    ):
        self.message_id = message_id
        self.chat_id = chat_id
        self.text = text
        self.timestamp = timestamp
        self.sender_name = sender_name
        self.chat_name = chat_name
        self.rank = rank


class MockPendingEmbedding:
    """Mock for core.PendingEmbedding returned by get_pending_embeddings."""

    def __init__(self, id: int, chat_id: int, text: str | None):
        self.id = id
        self.chat_id = chat_id
        self.text = text


class MockStoredEmbedding:
    """Mock for core.StoredEmbedding returned by get_all_embeddings."""

    def __init__(self, message_id: int, chat_id: int, embedding: bytes):
        self.message_id = message_id
        self.chat_id = chat_id
        self.embedding = embedding


class MockSyncedContact:
    """Mock for core.SyncedContact returned by contacts sync."""

    def __init__(
        self,
        id: int = 1,
        apple_id: str = "",
        name: str = "",
        phones: list[str] | None = None,
        emails: list[str] | None = None,
        company: str | None = None,
        notes: str | None = None,
        apple_created_at: int = 700000000,
        apple_modified_at: int = 700000000,
    ):
        self.id = id
        self.apple_id = apple_id
        self.name = name
        self.phones = phones or []
        self.emails = emails or []
        self.company = company
        self.notes = notes
        self.apple_created_at = apple_created_at
        self.apple_modified_at = apple_modified_at


@pytest.fixture
def mock_app_db() -> MagicMock:
    """Create a mock AppDb with sample data."""
    db = MagicMock()

    # Sample chats
    db.get_all_chats.return_value = [
        MockPrmChat(
            id=1,
            identifier="+11234567890",
            name="John Doe",
            is_group=False,
            last_message_text="Hello!",
            last_message_timestamp=700000000,  # Unix timestamp
        ),
        MockPrmChat(
            id=2,
            identifier="chat123456789",
            name="Family Group",
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
                name="John Doe",
                is_group=False,
                last_message_text="Hello!",
                last_message_timestamp=700000000,
            ),
            2: MockPrmChat(
                id=2,
                identifier="chat123456789",
                name="Family Group",
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

    # Sample actions
    sample_actions = [
        MockAction(
            id=1,
            action_type="respond_to_message",
            status="pending",
            priority=60,
            chat_id=1,
            person_id=1,
            message_id=1,
            payload='{"message_preview": "Hello!", "hours_since": 48}',
            chat_name="John Doe",
            person_name="John Doe",
            message_text="Hello!",
            message_timestamp=700000000,
        ),
        MockAction(
            id=2,
            action_type="eod_contact",
            status="pending",
            priority=50,
            person_id=2,
            person_name="Jane Smith",
        ),
    ]

    db.get_pending_actions.return_value = sample_actions

    def get_action(action_id: int) -> MockAction | None:
        for a in sample_actions:
            if a.id == action_id:
                return a
        return None

    db.get_action.side_effect = get_action
    db.create_action.return_value = 3  # Return new action ID
    db.update_action_status.return_value = None
    db.delete_action.return_value = None

    # Unanswered chats
    db.get_unanswered_chats.return_value = [
        MockUnansweredChat(
            message_id=10,
            chat_id=1,
            sender_id=1,
            text="Are you coming to the party?",
            timestamp=700000000,
            chat_name="John Doe",
            person_name="John Doe",
            hours_since=72,
        ),
    ]

    # Search results
    db.search_messages.return_value = [
        MockSearchResult(
            message_id=1,
            chat_id=1,
            text="Hello!",
            timestamp=700000000,
            sender_name="John Doe",
            chat_name="John Doe",
            rank=1.5,
        ),
    ]
    db.rebuild_fts_index.return_value = 100

    # Get message text
    db.get_message_text.return_value = "Hello!"

    # Get single message (used by unified search for semantic results)
    def get_message(message_id: int) -> MockPrmMessage | None:
        messages = {
            1: MockPrmMessage(
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
            2: MockPrmMessage(
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
        }
        return messages.get(message_id)

    db.get_message.side_effect = get_message

    # EOD contacts
    db.get_todays_new_contacts.return_value = [
        MockPerson(id=3, identifier="+15551234567", name="New Contact"),
    ]
    db.has_eod_action_today.return_value = False

    # Get person
    def get_person(person_id: int) -> MockPerson | None:
        people = {
            1: MockPerson(id=1, identifier="+11234567890", name="John Doe"),
            2: MockPerson(id=2, identifier="+10987654321", name="Jane Smith"),
            3: MockPerson(id=3, identifier="+15551234567", name="New Contact"),
        }
        return people.get(person_id)

    db.get_person.side_effect = get_person
    db.upsert_person.return_value = None

    # Contact sync methods
    db.get_contact_stats.return_value = (100, 5)  # (active, deleted)
    db.get_sync_state.return_value = 700000000  # Last sync timestamp
    db.get_latest_contact_modification.return_value = 700000000
    db.get_all_contact_apple_ids.return_value = ["ABC123", "DEF456", "GHI789"]
    db.upsert_contact.return_value = 1  # Return contact ID
    db.mark_contacts_deleted.return_value = 0
    db.get_all_contacts.return_value = [
        MockSyncedContact(
            id=1,
            apple_id="ABC123",
            name="John Doe",
            phones=["+11234567890"],
            emails=["john@example.com"],
            company="Acme Inc",
        ),
        MockSyncedContact(
            id=2,
            apple_id="DEF456",
            name="Jane Smith",
            phones=["+10987654321"],
            emails=["jane@example.com"],
        ),
    ]

    # Attachments - return None for unknown IDs
    db.get_attachment.return_value = None

    return db


@pytest.fixture
def client(mock_app_db: MagicMock) -> Generator[TestClient, None, None]:
    """Create a test client with mocked dependencies."""
    with (
        patch("routers.chats.get_app_db", return_value=mock_app_db),
        patch("routers.chats.trigger_background_sync", None),
        patch("routers.actions.get_db", return_value=mock_app_db),
        patch("routers.search.get_db", return_value=mock_app_db),
        patch("routers.eod.get_db", return_value=mock_app_db),
        patch("routers.contacts.get_db", return_value=mock_app_db),
        patch("routers.attachments.get_app_db", return_value=mock_app_db),
        patch("main.run_sync"),  # Skip sync on startup
        patch("main.has_existing_data", return_value=True),  # Pretend data exists
        patch("main.trigger_background_sync"),  # Don't trigger background sync
        patch("main.start_sync_watcher"),  # Skip sync watcher
        patch("main.start_scheduler"),  # Skip background scheduler
        patch("core.normalize_phone", side_effect=lambda x: x.replace("+", "")),
        patch("core.normalize_email", side_effect=lambda x: x.lower()),
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
