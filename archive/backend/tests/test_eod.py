"""Tests for EOD (End of Day) router endpoints."""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from tests.conftest import MockPerson


class TestGetEODContacts:
    """Tests for GET /eod/contacts endpoint."""

    def test_get_eod_contacts(self, client: TestClient, mock_app_db: MagicMock):
        """Get today's new contacts."""
        response = client.get("/eod/contacts")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1

    def test_get_eod_contacts_structure(self, client: TestClient):
        """EOD contact response has correct structure."""
        response = client.get("/eod/contacts")
        data = response.json()
        contact = data[0]

        assert contact["person_id"] == 3
        assert contact["identifier"] == "+15551234567"
        assert contact["name"] == "New Contact"
        assert contact["is_contact"] is True

    def test_get_eod_contacts_empty(self, client: TestClient, mock_app_db: MagicMock):
        """Get EOD contacts when none found."""
        mock_app_db.get_todays_new_contacts.return_value = []

        response = client.get("/eod/contacts")
        assert response.status_code == 200
        assert response.json() == []


class TestGenerateEODActions:
    """Tests for POST /eod/generate endpoint."""

    def test_generate_eod_actions(self, client: TestClient, mock_app_db: MagicMock):
        """Generate EOD actions for new contacts."""
        response = client.post("/eod/generate")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["actions_created"] == 1

        # Verify create_action was called
        mock_app_db.create_action.assert_called_once()
        call_kwargs = mock_app_db.create_action.call_args[1]
        assert call_kwargs["action_type"] == "eod_contact"
        assert call_kwargs["priority"] == 30
        assert call_kwargs["person_id"] == 3

    def test_generate_eod_actions_skips_existing(self, client: TestClient, mock_app_db: MagicMock):
        """Skip contacts that already have EOD action today."""
        mock_app_db.has_eod_action_today.return_value = True

        response = client.post("/eod/generate")
        assert response.status_code == 200
        data = response.json()
        assert data["actions_created"] == 0
        mock_app_db.create_action.assert_not_called()

    def test_generate_eod_actions_multiple_contacts(
        self, client: TestClient, mock_app_db: MagicMock
    ):
        """Generate actions for multiple new contacts."""
        mock_app_db.get_todays_new_contacts.return_value = [
            MockPerson(id=3, identifier="+15551234567", name="New Contact 1"),
            MockPerson(id=4, identifier="+15559876543", name="New Contact 2"),
            MockPerson(id=5, identifier="+15551112222", name="New Contact 3"),
        ]
        mock_app_db.has_eod_action_today.return_value = False

        response = client.post("/eod/generate")
        assert response.status_code == 200
        data = response.json()
        assert data["actions_created"] == 3
        assert mock_app_db.create_action.call_count == 3

    def test_generate_eod_actions_empty(self, client: TestClient, mock_app_db: MagicMock):
        """No actions created when no new contacts."""
        mock_app_db.get_todays_new_contacts.return_value = []

        response = client.post("/eod/generate")
        assert response.status_code == 200
        data = response.json()
        assert data["actions_created"] == 0


class TestAddContactContext:
    """Tests for POST /eod/contacts/{person_id}/context endpoint."""

    def test_add_contact_context(self, client: TestClient, mock_app_db: MagicMock):
        """Add context/notes to a person."""
        response = client.post(
            "/eod/contacts/1/context",
            params={"notes": "Met at conference in NYC"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True

        # Verify upsert_person was called with notes
        mock_app_db.upsert_person.assert_called_once()
        call_kwargs = mock_app_db.upsert_person.call_args[1]
        assert call_kwargs["notes"] == "Met at conference in NYC"
        assert call_kwargs["id"] == 1

    def test_add_contact_context_preserves_existing_data(
        self, client: TestClient, mock_app_db: MagicMock
    ):
        """Adding context preserves existing person data."""
        response = client.post(
            "/eod/contacts/1/context",
            params={"notes": "Works at tech startup"},
        )
        assert response.status_code == 200

        # Verify existing fields are preserved
        call_kwargs = mock_app_db.upsert_person.call_args[1]
        assert call_kwargs["identifier"] == "+11234567890"
        assert call_kwargs["name"] == "John Doe"
        assert call_kwargs["service"] == "iMessage"
        assert call_kwargs["is_contact"] is True

    def test_add_contact_context_person_not_found(self, client: TestClient, mock_app_db: MagicMock):
        """Adding context to non-existent person returns 404."""
        mock_app_db.get_person.side_effect = lambda person_id: None

        response = client.post(
            "/eod/contacts/999/context",
            params={"notes": "Some notes"},
        )
        assert response.status_code == 404
        assert response.json()["detail"] == "Person not found"
