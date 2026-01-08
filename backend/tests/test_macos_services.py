"""Tests for macOS services (contacts and messaging)."""

import json
import sys
from unittest.mock import MagicMock, patch

import pytest

from services.macos import (
    ContactsAccessDeniedError,
    ContactsError,
    FetchedContact,
    SendResult,
    fetch_all_contacts,
    is_swift_contacts_available,
    send_message,
    send_to_group,
)
from services.macos.contacts import _parse_error
from services.macos.messaging import _escape_applescript_string

# =============================================================================
# FetchedContact Model Tests
# =============================================================================


class TestFetchedContactModel:
    """Tests for FetchedContact pydantic model."""

    def test_creates_with_defaults(self):
        """Creates contact with default empty lists."""
        contact = FetchedContact(name="Test")

        assert contact.name == "Test"
        assert contact.emails == []
        assert contact.phones == []
        assert contact.company is None
        assert contact.notes is None

    def test_creates_with_all_fields(self):
        """Creates contact with all fields."""
        contact = FetchedContact(
            name="Full Contact",
            emails=["a@b.com"],
            phones=["+1"],
            company="Corp",
            notes="Notes here",
        )

        assert contact.name == "Full Contact"
        assert contact.emails == ["a@b.com"]
        assert contact.phones == ["+1"]
        assert contact.company == "Corp"
        assert contact.notes == "Notes here"


# =============================================================================
# Swift CLI Helper Tests
# =============================================================================


class TestParseError:
    """Tests for _parse_error helper."""

    def test_parses_json_error(self):
        """Parses JSON error from stderr."""
        stderr = '{"error": "Contacts access denied"}\n'
        assert _parse_error(stderr) == "Contacts access denied"

    def test_returns_raw_string_on_invalid_json(self):
        """Returns raw string if not valid JSON."""
        stderr = "Some error message"
        assert _parse_error(stderr) == "Some error message"

    def test_returns_none_for_empty(self):
        """Returns None for empty stderr."""
        assert _parse_error("") is None
        assert _parse_error("   ") is None


class TestSwiftContactsAvailability:
    """Tests for Swift CLI availability checking."""

    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_is_available_when_binary_exists_and_executable(self, mock_path):
        """Returns True when binary exists and is executable."""
        mock_path_obj = MagicMock()
        mock_path_obj.exists.return_value = True
        mock_path.return_value = mock_path_obj

        with patch("os.access", return_value=True):
            assert is_swift_contacts_available() is True

    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_is_not_available_when_binary_missing(self, mock_path):
        """Returns False when binary doesn't exist."""
        mock_path_obj = MagicMock()
        mock_path_obj.exists.return_value = False
        mock_path.return_value = mock_path_obj

        assert is_swift_contacts_available() is False


# =============================================================================
# Swift CLI Fetch Tests (Mocked)
# =============================================================================


class TestFetchAllContactsMocked:
    """Tests for fetch_all_contacts with mocked subprocess."""

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_returns_parsed_contacts(self, mock_path, mock_run, mock_available):
        """Parses JSON output from Swift CLI."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "contacts": [
                        {
                            "name": "John Doe",
                            "emails": ["john@example.com"],
                            "phones": ["+1234567890"],
                            "company": "Acme",
                        },
                        {
                            "name": "Jane Smith",
                            "emails": ["jane@example.com"],
                            "phones": [],
                            "company": None,
                        },
                    ],
                    "count": 2,
                    "elapsed_seconds": 0.05,
                }
            ),
            stderr="",
        )

        contacts = fetch_all_contacts()

        assert len(contacts) == 2
        assert contacts[0].name == "John Doe"
        assert contacts[0].company == "Acme"
        assert contacts[0].emails == ["john@example.com"]
        assert contacts[1].name == "Jane Smith"
        assert contacts[1].company is None

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_handles_empty_contacts(self, mock_path, mock_run, mock_available):
        """Handles empty contacts list."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"contacts": [], "count": 0, "elapsed_seconds": 0.01}),
            stderr="",
        )

        contacts = fetch_all_contacts()

        assert contacts == []

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_raises_when_binary_unavailable(self, mock_path, mock_available):
        """Raises ContactsError when Swift CLI unavailable."""
        mock_available.return_value = False
        mock_path.return_value = MagicMock(__str__=lambda x: "/missing/prm-contacts")

        with pytest.raises(ContactsError) as exc:
            fetch_all_contacts()

        assert "not found" in str(exc.value)

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_raises_access_denied_on_exit_code_2(self, mock_path, mock_run, mock_available):
        """Raises ContactsAccessDeniedError on exit code 2."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=2,
            stdout="",
            stderr='{"error": "Contacts access denied"}',
        )

        with pytest.raises(ContactsAccessDeniedError) as exc:
            fetch_all_contacts()

        assert "denied" in str(exc.value).lower()

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_raises_on_invalid_json(self, mock_path, mock_run, mock_available):
        """Raises ContactsError on invalid JSON output."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="not valid json",
            stderr="",
        )

        with pytest.raises(ContactsError) as exc:
            fetch_all_contacts()

        assert "Invalid JSON" in str(exc.value)

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_handles_missing_contact_fields(self, mock_path, mock_run, mock_available):
        """Handles contacts with missing optional fields gracefully."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "contacts": [
                        {"name": "Minimal Contact"},  # Missing emails, phones, company
                    ],
                    "count": 1,
                    "elapsed_seconds": 0.01,
                }
            ),
            stderr="",
        )

        contacts = fetch_all_contacts()

        assert len(contacts) == 1
        assert contacts[0].name == "Minimal Contact"
        assert contacts[0].emails == []
        assert contacts[0].phones == []
        assert contacts[0].company is None

    @patch("services.macos.contacts.is_swift_contacts_available")
    @patch("services.macos.contacts.subprocess.run")
    @patch("services.macos.contacts.get_contacts_binary_path")
    def test_raises_on_missing_name_field(self, mock_path, mock_run, mock_available):
        """Raises error when contact is missing required name field."""
        mock_available.return_value = True
        mock_path.return_value = MagicMock(__str__=lambda x: "/path/to/prm-contacts")

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "contacts": [
                        {"emails": ["test@example.com"]},  # Missing name
                    ],
                    "count": 1,
                    "elapsed_seconds": 0.01,
                }
            ),
            stderr="",
        )

        with pytest.raises(ContactsError) as exc:
            fetch_all_contacts()

        assert "name" in str(exc.value).lower()


# =============================================================================
# Messaging Helper Tests (Unit tests - no AppleScript execution)
# =============================================================================


class TestEscapeApplescriptString:
    """Tests for _escape_applescript_string helper."""

    def test_escapes_backslash(self):
        """Escapes backslashes."""
        assert _escape_applescript_string("a\\b") == "a\\\\b"

    def test_escapes_double_quotes(self):
        """Escapes double quotes."""
        assert _escape_applescript_string('say "hello"') == 'say \\"hello\\"'

    def test_escapes_both(self):
        """Escapes both backslashes and quotes."""
        assert _escape_applescript_string('path\\to\\"file"') == 'path\\\\to\\\\\\"file\\"'

    def test_leaves_normal_strings_unchanged(self):
        """Doesn't modify strings without special chars."""
        assert _escape_applescript_string("Hello World!") == "Hello World!"

    def test_handles_empty_string(self):
        """Handles empty string."""
        assert _escape_applescript_string("") == ""


class TestSendResultModel:
    """Tests for SendResult pydantic model."""

    def test_creates_success(self):
        """Creates successful result."""
        result = SendResult(success=True, recipient="+1234567890")

        assert result.success is True
        assert result.error is None
        assert result.recipient == "+1234567890"

    def test_creates_failure(self):
        """Creates failure result with error."""
        result = SendResult(
            success=False,
            error="Connection failed",
            recipient="+1234567890",
        )

        assert result.success is False
        assert result.error == "Connection failed"
        assert result.recipient == "+1234567890"


# =============================================================================
# Mocked AppleScript Messaging Tests
# =============================================================================


class TestSendMessageMocked:
    """Tests for send_message with mocked subprocess."""

    @patch("services.macos.messaging.subprocess.run")
    def test_returns_success_on_success(self, mock_run):
        """Returns success result on successful send."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="",
            stderr="",
        )

        result = send_message("+1234567890", "Hello!")

        assert result.success is True
        assert result.error is None
        assert result.recipient == "+1234567890"

    @patch("services.macos.messaging.subprocess.run")
    def test_returns_failure_on_error(self, mock_run):
        """Returns failure result with error message."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="execution error: Messages got an error",
        )

        result = send_message("+1234567890", "Hello!")

        assert result.success is False
        assert "Messages got an error" in result.error
        assert result.recipient == "+1234567890"

    @patch("services.macos.messaging.subprocess.run")
    def test_escapes_message_content(self, mock_run):
        """Escapes special characters in message."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        send_message("+1", 'Say "hello" and use \\ backslash')

        # Verify osascript was called
        mock_run.assert_called_once()
        script = mock_run.call_args[0][0][2]  # Get the script argument
        assert '\\"hello\\"' in script
        assert "\\\\" in script


class TestSendToGroupMocked:
    """Tests for send_to_group with mocked subprocess."""

    @patch("services.macos.messaging.subprocess.run")
    def test_formats_chat_identifier(self, mock_run):
        """Prepends iMessage prefix to chat identifier."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        send_to_group("chat123456789", "Hello group!")

        script = mock_run.call_args[0][0][2]
        assert "iMessage;+;chat123456789" in script

    @patch("services.macos.messaging.subprocess.run")
    def test_preserves_full_identifier(self, mock_run):
        """Doesn't modify identifier if already formatted."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        send_to_group("iMessage;+;chat123456789", "Hello!")

        script = mock_run.call_args[0][0][2]
        # Should not double-prefix
        assert "iMessage;+;iMessage;+;" not in script

    @patch("services.macos.messaging.subprocess.run")
    def test_returns_success(self, mock_run):
        """Returns success result."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        result = send_to_group("chat123", "Hello!")

        assert result.success is True
        assert result.recipient == "chat123"

    @patch("services.macos.messaging.subprocess.run")
    def test_returns_failure(self, mock_run):
        """Returns failure result on error."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="Chat not found",
        )

        result = send_to_group("chat123", "Hello!")

        assert result.success is False
        assert "Chat not found" in result.error


# =============================================================================
# Integration Tests (marked slow - require real execution)
# =============================================================================


@pytest.mark.slow
@pytest.mark.integration
@pytest.mark.skipif(sys.platform != "darwin", reason="macOS-only: requires Contacts.framework")
class TestContactsIntegration:
    """Integration tests for contacts (requires macOS + Contacts.app)."""

    def test_fetch_all_contacts_runs(self):
        """fetch_all_contacts executes without error if Swift CLI available."""
        if not is_swift_contacts_available():
            pytest.skip("Swift contacts CLI not available")

        contacts = fetch_all_contacts()
        assert isinstance(contacts, list)


@pytest.mark.slow
@pytest.mark.integration
@pytest.mark.skipif(sys.platform != "darwin", reason="macOS-only: requires osascript")
class TestMessagingIntegration:
    """Integration tests for messaging (requires macOS + Messages.app).

    NOTE: These tests are commented out to prevent accidentally sending messages.
    Uncomment and modify recipient for manual testing.
    """

    def test_send_message_to_invalid_recipient(self):
        """send_message returns error for invalid recipient."""
        # This should fail safely without sending anything
        result = send_message("not-a-valid-recipient-12345", "Test")
        # May succeed or fail depending on Messages.app state
        assert isinstance(result, SendResult)
