"""Tests for actions router endpoints."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from tests.conftest import MockAction, MockSendResult


class TestGetActions:
    """Tests for GET /actions endpoint."""

    def test_get_actions_returns_list(self, client: TestClient):
        """Get pending actions returns a list."""
        response = client.get("/actions/")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2

    def test_get_actions_structure(self, client: TestClient):
        """Action response has correct structure."""
        response = client.get("/actions/")
        data = response.json()
        action = data[0]

        assert action["id"] == 1
        assert action["type"] == "respond_to_message"
        assert action["status"] == "pending"
        assert action["priority"] == 60
        assert action["chat_id"] == 1
        assert action["person_id"] == 1
        assert action["message_id"] == 1
        assert action["chat_name"] == "John Doe"
        assert action["person_name"] == "John Doe"
        assert action["payload"]["message_preview"] == "Hello!"
        assert action["payload"]["hours_since"] == 48

    def test_get_actions_includes_recent_messages(self, client: TestClient):
        """Actions include recent messages for context."""
        response = client.get("/actions/")
        data = response.json()
        action = data[0]

        assert "recent_messages" in action
        assert len(action["recent_messages"]) > 0
        assert action["recent_messages"][0]["text"] == "Hello!"

    def test_get_actions_with_limit(self, client: TestClient):
        """Limit parameter is passed to database."""
        response = client.get("/actions/?limit=10")
        assert response.status_code == 200


class TestGetSingleAction:
    """Tests for GET /actions/{action_id} endpoint."""

    def test_get_action_by_id(self, client: TestClient):
        """Get single action by ID."""
        response = client.get("/actions/1")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 1
        assert data["type"] == "respond_to_message"

    def test_get_action_not_found(self, client: TestClient):
        """Get non-existent action returns 404."""
        response = client.get("/actions/999")
        assert response.status_code == 404
        assert response.json()["detail"] == "Action not found"


class TestCreateAction:
    """Tests for POST /actions endpoint."""

    def test_create_action_respond_to_message(self, client: TestClient, mock_app_db: MagicMock):
        """Create a respond_to_message action."""
        # Make get_action return the newly created action
        mock_app_db.get_action.side_effect = lambda action_id: MockAction(
            id=3,
            action_type="respond_to_message",
            status="pending",
            priority=70,
            chat_id=1,
            person_id=1,
            message_id=1,
            chat_name="John Doe",
            person_name="John Doe",
        )

        response = client.post(
            "/actions/",
            json={
                "type": "respond_to_message",
                "priority": 70,
                "chat_id": 1,
                "person_id": 1,
                "message_id": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "respond_to_message"
        assert data["priority"] == 70

    def test_create_action_eod_contact(self, client: TestClient, mock_app_db: MagicMock):
        """Create an eod_contact action."""
        mock_app_db.get_action.side_effect = lambda action_id: MockAction(
            id=3,
            action_type="eod_contact",
            status="pending",
            priority=50,
            person_id=2,
            person_name="Jane Smith",
        )

        response = client.post(
            "/actions/",
            json={
                "type": "eod_contact",
                "priority": 50,
                "person_id": 2,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "eod_contact"

    def test_create_action_with_payload(self, client: TestClient, mock_app_db: MagicMock):
        """Create action with custom payload."""
        mock_app_db.get_action.side_effect = lambda action_id: MockAction(
            id=3,
            action_type="follow_up",
            status="pending",
            priority=40,
            payload='{"reason": "test"}',
        )

        response = client.post(
            "/actions/",
            json={
                "type": "follow_up",
                "priority": 40,
                "payload": {"reason": "test"},
            },
        )
        assert response.status_code == 200


class TestSwipeAction:
    """Tests for POST /actions/{action_id}/swipe endpoint."""

    def test_swipe_left_discards(self, client: TestClient, mock_app_db: MagicMock):
        """Swipe left discards the action."""
        # Return updated action after swipe
        mock_app_db.get_action.side_effect = [
            MockAction(id=1, action_type="respond_to_message", status="pending"),
            MockAction(id=1, action_type="respond_to_message", status="discarded"),
        ]

        response = client.post(
            "/actions/1/swipe",
            json={"direction": "left"},
        )
        assert response.status_code == 200
        mock_app_db.update_action_status.assert_called_with(1, "discarded", None)

    def test_swipe_right_completes(self, client: TestClient, mock_app_db: MagicMock):
        """Swipe right completes the action."""
        mock_app_db.get_action.side_effect = [
            MockAction(id=1, action_type="respond_to_message", status="pending"),
            MockAction(id=1, action_type="respond_to_message", status="completed"),
        ]

        response = client.post(
            "/actions/1/swipe",
            json={"direction": "right"},
        )
        assert response.status_code == 200
        mock_app_db.update_action_status.assert_called_with(1, "completed", None)

    def test_swipe_right_with_response_sends_message(
        self, client: TestClient, mock_app_db: MagicMock
    ):
        """Swipe right with response_text sends a message."""
        mock_app_db.get_action.side_effect = [
            MockAction(id=1, action_type="respond_to_message", status="pending", chat_id=1),
            MockAction(id=1, action_type="respond_to_message", status="completed", chat_id=1),
        ]

        with patch("core.send_message", return_value=MockSendResult(success=True)) as mock_send:
            response = client.post(
                "/actions/1/swipe",
                json={"direction": "right", "response_text": "Hey, sorry for the delay!"},
            )
            assert response.status_code == 200
            mock_send.assert_called_once()

    def test_swipe_up_snoozes(self, client: TestClient, mock_app_db: MagicMock):
        """Swipe up snoozes the action."""
        mock_app_db.get_action.side_effect = [
            MockAction(id=1, action_type="respond_to_message", status="pending"),
            MockAction(id=1, action_type="respond_to_message", status="snoozed"),
        ]

        response = client.post(
            "/actions/1/swipe",
            json={"direction": "up", "snooze_minutes": 60},
        )
        assert response.status_code == 200
        # Check that update_action_status was called with snoozed status
        call_args = mock_app_db.update_action_status.call_args
        assert call_args[0][0] == 1
        assert call_args[0][1] == "snoozed"
        assert call_args[0][2] is not None  # snooze_until timestamp

    def test_swipe_action_not_found(self, client: TestClient, mock_app_db: MagicMock):
        """Swipe on non-existent action returns 404."""
        mock_app_db.get_action.side_effect = lambda action_id: None

        response = client.post(
            "/actions/999/swipe",
            json={"direction": "left"},
        )
        assert response.status_code == 404


class TestDeleteAction:
    """Tests for DELETE /actions/{action_id} endpoint."""

    def test_delete_action(self, client: TestClient, mock_app_db: MagicMock):
        """Delete an action."""
        response = client.delete("/actions/1")
        assert response.status_code == 200
        assert response.json()["success"] is True
        mock_app_db.delete_action.assert_called_with(1)


class TestGenerateUnansweredActions:
    """Tests for POST /actions/generate/unanswered endpoint."""

    def test_generate_unanswered_actions(self, client: TestClient, mock_app_db: MagicMock):
        """Generate actions for unanswered messages."""
        response = client.post("/actions/generate/unanswered")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["actions_created"] == 1

        # Check that create_action was called with correct parameters
        mock_app_db.create_action.assert_called_once()
        call_kwargs = mock_app_db.create_action.call_args[1]
        assert call_kwargs["action_type"] == "respond_to_message"
        assert call_kwargs["priority"] == 60
        assert call_kwargs["chat_id"] == 1
        assert call_kwargs["message_id"] == 10

    def test_generate_unanswered_actions_with_threshold(
        self, client: TestClient, mock_app_db: MagicMock
    ):
        """Generate actions with custom threshold."""
        response = client.post("/actions/generate/unanswered?threshold_hours=48")
        assert response.status_code == 200
        mock_app_db.get_unanswered_chats.assert_called_with(48)

    def test_generate_unanswered_actions_empty(self, client: TestClient, mock_app_db: MagicMock):
        """Generate actions when no unanswered messages."""
        mock_app_db.get_unanswered_chats.return_value = []

        response = client.post("/actions/generate/unanswered")
        assert response.status_code == 200
        data = response.json()
        assert data["actions_created"] == 0
