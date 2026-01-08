"""Tests for contacts sync endpoints and functionality."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from tests.conftest import MockSyncedContact


class TestGetContactsStatus:
    """Tests for GET /contacts/status endpoint."""

    def test_get_contacts_status_returns_dict(self, client: TestClient, mock_app_db: MagicMock):
        """Status endpoint returns a dict with sync info."""
        response = client.get("/contacts/status")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_contacts_status_structure(self, client: TestClient, mock_app_db: MagicMock):
        """Status response has expected fields."""
        response = client.get("/contacts/status")
        assert response.status_code == 200
        data = response.json()

        assert "total_contacts" in data
        assert "deleted_contacts" in data
        assert "last_sync_timestamp" in data
        assert "last_modification_timestamp" in data

        # Verify values from mock
        assert data["total_contacts"] == 100
        assert data["deleted_contacts"] == 5


class TestGetContactsStats:
    """Tests for GET /contacts/stats endpoint."""

    def test_get_contacts_stats_returns_counts(self, client: TestClient, mock_app_db: MagicMock):
        """Stats endpoint returns active, deleted, and total counts."""
        response = client.get("/contacts/stats")
        assert response.status_code == 200
        data = response.json()

        assert data["active"] == 100
        assert data["deleted"] == 5
        assert data["total"] == 105


class TestTriggerContactsSync:
    """Tests for POST /contacts/sync endpoint."""

    def test_trigger_sync_calls_sync_contacts(self, client: TestClient, mock_app_db: MagicMock):
        """Sync endpoint calls the sync_contacts function."""
        mock_result = MagicMock()
        mock_result.to_dict.return_value = {
            "synced": 50,
            "created": 10,
            "updated": 40,
            "deleted": 0,
            "duration_seconds": 1.5,
            "is_full_sync": False,
        }

        with patch("routers.contacts.sync_contacts", return_value=mock_result):
            response = client.post("/contacts/sync")

        assert response.status_code == 200
        data = response.json()
        assert data["synced"] == 50
        assert data["is_full_sync"] is False

    def test_trigger_sync_with_force_full(self, client: TestClient, mock_app_db: MagicMock):
        """Sync with force_full=True triggers full sync."""
        mock_result = MagicMock()
        mock_result.to_dict.return_value = {
            "synced": 100,
            "created": 100,
            "updated": 0,
            "deleted": 0,
            "duration_seconds": 3.0,
            "is_full_sync": True,
        }

        with patch("routers.contacts.sync_contacts", return_value=mock_result) as mock_sync:
            response = client.post("/contacts/sync?force_full=true")
            mock_sync.assert_called_once()
            # Check force_full was passed
            call_kwargs = mock_sync.call_args[1]
            assert call_kwargs["force_full"] is True

        assert response.status_code == 200
        data = response.json()
        assert data["is_full_sync"] is True


class TestTriggerFullContactsSync:
    """Tests for POST /contacts/sync/full endpoint."""

    def test_full_sync_returns_result(self, client: TestClient, mock_app_db: MagicMock):
        """Full sync endpoint returns sync result."""
        mock_result = MagicMock()
        mock_result.to_dict.return_value = {
            "synced": 200,
            "created": 200,
            "updated": 0,
            "deleted": 5,
            "duration_seconds": 5.0,
            "is_full_sync": True,
        }

        with patch("routers.contacts.sync_contacts_full", return_value=mock_result):
            response = client.post("/contacts/sync/full")

        assert response.status_code == 200
        data = response.json()
        assert data["synced"] == 200
        assert data["is_full_sync"] is True


class TestContactSyncResult:
    """Tests for ContactSyncResult class."""

    def test_sync_result_to_dict(self):
        """ContactSyncResult.to_dict() returns expected format."""
        from contact_sync import ContactSyncResult

        result = ContactSyncResult(
            synced=100,
            created=50,
            updated=40,
            deleted=10,
            duration_seconds=2.5,
            is_full_sync=True,
        )

        data = result.to_dict()
        assert data["synced"] == 100
        assert data["created"] == 50
        assert data["updated"] == 40
        assert data["deleted"] == 10
        assert data["duration_seconds"] == 2.5
        assert data["is_full_sync"] is True

    def test_sync_result_repr(self):
        """ContactSyncResult has useful repr."""
        from contact_sync import ContactSyncResult

        result = ContactSyncResult(synced=100, created=50)
        repr_str = repr(result)
        assert "synced=100" in repr_str
        assert "created=50" in repr_str


class TestContactSyncStatus:
    """Tests for ContactSyncStatus class."""

    def test_sync_status_to_dict(self):
        """ContactSyncStatus.to_dict() returns expected format."""
        from contact_sync import ContactSyncStatus

        status = ContactSyncStatus(
            total_contacts=100,
            deleted_contacts=5,
            last_sync_timestamp=700000000,
            last_modification_timestamp=700000001,
        )

        data = status.to_dict()
        assert data["total_contacts"] == 100
        assert data["deleted_contacts"] == 5
        assert data["last_sync_timestamp"] == 700000000
        assert data["last_modification_timestamp"] == 700000001


class TestSyncedContactLookup:
    """Tests for SyncedContactLookup class."""

    def test_lookup_by_phone(self, mock_app_db: MagicMock):
        """Lookup finds contact by phone number."""
        from contact_sync import SyncedContactLookup

        lookup = SyncedContactLookup(mock_app_db)

        # Mock contacts have +11234567890 for John Doe
        name = lookup.get_name("+11234567890")
        assert name == "John Doe"

    def test_lookup_by_email(self, mock_app_db: MagicMock):
        """Lookup finds contact by email."""
        from contact_sync import SyncedContactLookup

        lookup = SyncedContactLookup(mock_app_db)

        # Mock contacts have john@example.com for John Doe
        name = lookup.get_name("john@example.com")
        assert name == "John Doe"

    def test_lookup_returns_none_for_unknown(self, mock_app_db: MagicMock):
        """Lookup returns None for unknown identifier."""
        from contact_sync import SyncedContactLookup

        lookup = SyncedContactLookup(mock_app_db)

        name = lookup.get_name("+19999999999")
        assert name is None

    def test_lookup_get_contact_returns_full_object(self, mock_app_db: MagicMock):
        """get_contact returns full SyncedContact object."""
        from contact_sync import SyncedContactLookup

        lookup = SyncedContactLookup(mock_app_db)

        contact = lookup.get_contact("+11234567890")
        assert contact is not None
        assert contact.name == "John Doe"
        assert contact.company == "Acme Inc"

    def test_lookup_strips_country_code(self, mock_app_db: MagicMock):
        """Lookup handles phone numbers without country code."""
        from contact_sync import SyncedContactLookup

        # Update mock to return contacts indexed by stripped phone
        mock_app_db.get_all_contacts.return_value = [
            MockSyncedContact(
                apple_id="ABC123",
                name="John Doe",
                phones=["11234567890"],  # Without + prefix
                emails=["john@example.com"],
            ),
        ]

        lookup = SyncedContactLookup(mock_app_db)

        # Should still find by full US number (strips leading 1)
        name = lookup.get_name("1234567890")
        assert name == "John Doe"

    def test_contact_count_property(self, mock_app_db: MagicMock):
        """contact_count returns number of unique contacts."""
        from contact_sync import SyncedContactLookup

        lookup = SyncedContactLookup(mock_app_db)

        # Mock has 2 contacts
        assert lookup.contact_count == 2


class TestSyncContactsFull:
    """Tests for sync_contacts_full function."""

    def test_full_sync_fetches_all_contacts(self, mock_app_db: MagicMock):
        """Full sync calls fetch_all_contacts_for_sync."""
        from contact_sync import sync_contacts_full

        mock_contacts = [
            MockSyncedContact(
                apple_id="NEW1",
                name="New Person",
                phones=["+15551234567"],
            ),
        ]

        with (
            patch(
                "contact_sync.core.fetch_all_contacts_for_sync",
                return_value=mock_contacts,
            ) as mock_fetch,
            patch("contact_sync.core.fetch_all_contact_ids", return_value=["NEW1"]),
        ):
            result = sync_contacts_full(mock_app_db, verbose=False)

        mock_fetch.assert_called_once()
        assert result.is_full_sync is True
        assert result.synced == 1

    def test_full_sync_upserts_contacts(self, mock_app_db: MagicMock):
        """Full sync calls upsert_contact for each contact."""
        from contact_sync import sync_contacts_full

        mock_contacts = [
            MockSyncedContact(
                apple_id="ABC123",
                name="John Doe",
                phones=["+11234567890"],
                emails=["john@example.com"],
                company="Acme Inc",
            ),
        ]

        with (
            patch(
                "contact_sync.core.fetch_all_contacts_for_sync",
                return_value=mock_contacts,
            ),
            patch("contact_sync.core.fetch_all_contact_ids", return_value=["ABC123"]),
        ):
            sync_contacts_full(mock_app_db, verbose=False)

        mock_app_db.upsert_contact.assert_called_once()
        call_kwargs = mock_app_db.upsert_contact.call_args[1]
        assert call_kwargs["apple_id"] == "ABC123"
        assert call_kwargs["name"] == "John Doe"


class TestSyncContactsIncremental:
    """Tests for sync_contacts_incremental function."""

    def test_incremental_sync_uses_modification_date(self, mock_app_db: MagicMock):
        """Incremental sync fetches only modified contacts."""
        from contact_sync import sync_contacts_incremental

        mock_modified = [
            MockSyncedContact(
                apple_id="MOD1",
                name="Modified Person",
                phones=["+15559876543"],
            ),
        ]

        with (
            patch(
                "contact_sync.core.fetch_contacts_modified_since",
                return_value=mock_modified,
            ) as mock_fetch,
            patch(
                "contact_sync.core.fetch_all_contact_ids",
                return_value=["ABC123", "DEF456", "MOD1"],
            ),
        ):
            result = sync_contacts_incremental(mock_app_db, verbose=False)

        mock_fetch.assert_called_once()
        # Should have been called with the last modification timestamp
        assert result.is_full_sync is False
        assert result.synced == 1

    def test_incremental_detects_deletions(self, mock_app_db: MagicMock):
        """Incremental sync detects and marks deleted contacts."""
        from contact_sync import sync_contacts_incremental

        # Simulate a contact was deleted from Apple Contacts
        # We have ABC123, DEF456, GHI789 in DB but only ABC123, DEF456 in Apple
        mock_app_db.get_all_contact_apple_ids.return_value = [
            "ABC123",
            "DEF456",
            "GHI789",
        ]

        with (
            patch("contact_sync.core.fetch_contacts_modified_since", return_value=[]),
            patch(
                "contact_sync.core.fetch_all_contact_ids",
                return_value=["ABC123", "DEF456"],  # GHI789 was deleted
            ),
        ):
            mock_app_db.mark_contacts_deleted.return_value = 1
            result = sync_contacts_incremental(mock_app_db, verbose=False)

        # Should have called mark_contacts_deleted with the deleted ID
        mock_app_db.mark_contacts_deleted.assert_called_once()
        deleted_ids = mock_app_db.mark_contacts_deleted.call_args[0][0]
        assert "GHI789" in deleted_ids
        assert result.deleted == 1


class TestSyncContacts:
    """Tests for sync_contacts wrapper function."""

    def test_sync_contacts_does_full_when_no_data(self, mock_app_db: MagicMock):
        """sync_contacts does full sync when no contacts exist."""
        from contact_sync import sync_contacts

        # Simulate empty database
        mock_app_db.get_contact_stats.return_value = (0, 0)

        mock_contacts = [
            MockSyncedContact(apple_id="NEW1", name="New Person"),
        ]

        with (
            patch(
                "contact_sync.core.fetch_all_contacts_for_sync",
                return_value=mock_contacts,
            ),
            patch("contact_sync.core.fetch_all_contact_ids", return_value=["NEW1"]),
        ):
            result = sync_contacts(mock_app_db, verbose=False)

        assert result.is_full_sync is True

    def test_sync_contacts_does_incremental_when_data_exists(self, mock_app_db: MagicMock):
        """sync_contacts does incremental sync when contacts exist."""
        from contact_sync import sync_contacts

        # mock_app_db already has contacts (100, 5)

        with (
            patch("contact_sync.core.fetch_contacts_modified_since", return_value=[]),
            patch(
                "contact_sync.core.fetch_all_contact_ids",
                return_value=["ABC123", "DEF456", "GHI789"],
            ),
        ):
            result = sync_contacts(mock_app_db, verbose=False)

        assert result.is_full_sync is False

    def test_sync_contacts_force_full_overrides(self, mock_app_db: MagicMock):
        """sync_contacts with force_full=True does full sync."""
        from contact_sync import sync_contacts

        mock_contacts = []

        with (
            patch(
                "contact_sync.core.fetch_all_contacts_for_sync",
                return_value=mock_contacts,
            ),
            patch("contact_sync.core.fetch_all_contact_ids", return_value=[]),
        ):
            result = sync_contacts(mock_app_db, force_full=True, verbose=False)

        assert result.is_full_sync is True
