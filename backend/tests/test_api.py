from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.conftest import MockSendResult


class TestRoot:
    """Tests for GET / endpoint."""

    def test_root_returns_prm_api(self, client: TestClient):
        """Root endpoint returns PRM API message."""
        response = client.get("/")
        assert response.status_code == 200
        assert response.json() == {"message": "PRM API"}


class TestNormalizePhone:
    """Tests for GET /test/normalize-phone/{phone} endpoint."""

    def test_normalize_phone(self, client: TestClient):
        """Normalize phone endpoint returns original and normalized."""
        response = client.get("/test/normalize-phone/+11234567890")
        assert response.status_code == 200
        data = response.json()
        assert data["original"] == "+11234567890"
        assert data["normalized"] == "11234567890"


class TestGetConversations:
    """Tests for GET /conversations endpoint."""

    def test_get_conversations_first_item_structure(self, client: TestClient):
        """First conversation has correct structure for 1:1 chat."""
        response = client.get("/conversations")
        data = response.json()
        conv = data[0]

        assert conv["id"] == 1
        assert conv["name"] == "John Doe"  # Resolved from handle
        assert conv["last_message"] == "Hello!"
        assert conv["is_group"] is False
        assert conv["handle_ids"] == ["+11234567890"]
        assert conv["member_names"] == ["John Doe"]

    def test_get_conversations_group_chat(self, client: TestClient):
        """Group chat has correct structure."""
        response = client.get("/conversations")
        data = response.json()
        conv = data[1]

        assert conv["id"] == 2
        assert conv["name"] == "Family Group"  # Uses display_name for groups
        assert conv["is_group"] is True
        assert len(conv["handle_ids"]) == 2

    def test_get_conversations_with_limit(self, client: TestClient):
        """Limit parameter restricts results."""
        response = client.get("/conversations?limit=1")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["id"] == 1

    def test_get_conversations_with_offset(self, client: TestClient):
        """Offset parameter skips results."""
        response = client.get("/conversations?offset=1")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["id"] == 2


class TestGetMessages:
    """Tests for GET /conversations/{chat_id}/messages endpoint."""

    def test_get_messages_structure(self, client: TestClient):
        """Messages have correct structure."""
        response = client.get("/conversations/1/messages")
        data = response.json()
        msg = data[0]

        assert msg["id"] == 1
        assert msg["text"] == "Hello!"
        assert msg["is_from_me"] is False
        assert msg["is_read"] is True
        assert msg["sender_name"] == "John Doe"

    def test_get_messages_from_me_no_sender(self, client: TestClient):
        """Messages from me have no sender_name."""
        response = client.get("/conversations/1/messages")
        data = response.json()
        msg = data[1]

        assert msg["is_from_me"] is True
        assert msg["sender_name"] is None


class TestSendMessage:
    """Tests for POST /conversations/{chat_id}/messages endpoint."""

    def test_send_message_success(self, client: TestClient):
        """Send message returns success."""
        response = client.post(
            "/conversations/1/messages",
            json={"text": "Test message"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["error"] is None

    def test_send_message_to_group(self, client: TestClient):
        """Send message to group chat."""
        response = client.post(
            "/conversations/2/messages",
            json={"text": "Group message"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True

    def test_send_message_chat_not_found(self, client: TestClient):
        """Send message to non-existent chat returns error."""
        response = client.post(
            "/conversations/999/messages",
            json={"text": "Test message"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["error"] == "Chat not found"

    def test_send_message_missing_text(self, client: TestClient):
        """Send message without text returns validation error."""
        response = client.post(
            "/conversations/1/messages",
            json={},
        )
        assert response.status_code == 422  # Validation error

    def test_send_message_failure(self, client: TestClient):
        """Send message failure returns error."""
        with patch(
            "core.send_message",
            return_value=MockSendResult(success=False, error="AppleScript error"),
        ):
            response = client.post(
                "/conversations/1/messages",
                json={"text": "Test message"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["success"] is False
            assert data["error"] == "AppleScript error"
