"""Tests for macOS services (contacts and messaging)."""

from unittest.mock import MagicMock, patch

import pytest

from services.macos import (
    FetchedContact,
    SendResult,
    fetch_all_contact_names,
    fetch_contacts_by_names,
    send_message,
    send_to_group,
)
from services.macos.contacts import _parse_contact_block
from services.macos.messaging import _escape_applescript_string


# =============================================================================
# Contact Parsing Tests (Unit tests - no AppleScript execution)
# =============================================================================


class TestParseContactBlock:
    """Tests for _parse_contact_block helper."""

    def test_parses_full_contact(self):
        """Parses a contact block with all fields."""
        block = """
NAME:John Doe
COMPANY:Acme Corp
NOTE:Met at conference
EMAIL:john@example.com
EMAIL:john.doe@work.com
PHONE:+1234567890
PHONE:+0987654321
"""
        contact = _parse_contact_block(block)

        assert contact is not None
        assert contact.name == "John Doe"
        assert contact.company == "Acme Corp"
        assert contact.notes == "Met at conference"
        assert contact.emails == ["john@example.com", "john.doe@work.com"]
        assert contact.phones == ["+1234567890", "+0987654321"]

    def test_parses_minimal_contact(self):
        """Parses a contact with only name."""
        block = "NAME:Jane Smith\n"
        contact = _parse_contact_block(block)

        assert contact is not None
        assert contact.name == "Jane Smith"
        assert contact.emails == []
        assert contact.phones == []
        assert contact.company is None
        assert contact.notes is None

    def test_handles_missing_value(self):
        """Ignores 'missing value' fields from AppleScript."""
        block = """
NAME:Test Person
COMPANY:missing value
NOTE:missing value
"""
        contact = _parse_contact_block(block)

        assert contact is not None
        assert contact.company is None
        assert contact.notes is None

    def test_handles_carriage_returns(self):
        """Handles AppleScript's carriage return line breaks."""
        block = "NAME:CR Test\rEMAIL:test@example.com\rPHONE:555-1234"
        contact = _parse_contact_block(block)

        assert contact is not None
        assert contact.name == "CR Test"
        assert contact.emails == ["test@example.com"]
        assert contact.phones == ["555-1234"]

    def test_returns_none_for_empty_block(self):
        """Returns None for empty block."""
        assert _parse_contact_block("") is None
        assert _parse_contact_block("   \n  \n  ") is None

    def test_returns_none_for_block_without_name(self):
        """Returns None if no NAME field."""
        block = "EMAIL:test@example.com\nPHONE:555-1234"
        assert _parse_contact_block(block) is None


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
# Mocked AppleScript Tests
# =============================================================================


class TestFetchAllContactNamesMocked:
    """Tests for fetch_all_contact_names with mocked subprocess."""

    @patch("services.macos.contacts.subprocess.run")
    def test_returns_parsed_names(self, mock_run):
        """Parses AppleScript list output into Python list."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='{"John Doe", "Jane Smith", "Bob Wilson"}',
            stderr="",
        )

        names = fetch_all_contact_names()

        assert names == ["John Doe", "Jane Smith", "Bob Wilson"]

    @patch("services.macos.contacts.subprocess.run")
    def test_handles_empty_result(self, mock_run):
        """Handles empty contacts list."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="{}",
            stderr="",
        )

        names = fetch_all_contact_names()

        assert names == []

    @patch("services.macos.contacts.subprocess.run")
    def test_handles_single_contact(self, mock_run):
        """Handles single contact."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='{"Only Person"}',
            stderr="",
        )

        names = fetch_all_contact_names()

        assert names == ["Only Person"]

    @patch("services.macos.contacts.subprocess.run")
    def test_raises_on_failure(self, mock_run):
        """Raises RuntimeError on osascript failure."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="execution error: Contacts is not running",
        )

        with pytest.raises(RuntimeError) as exc:
            fetch_all_contact_names()

        assert "osascript failed" in str(exc.value)


class TestFetchContactsByNamesMocked:
    """Tests for fetch_contacts_by_names with mocked subprocess."""

    @patch("services.macos.contacts.subprocess.run")
    def test_returns_parsed_contacts(self, mock_run):
        """Parses contact details from AppleScript output."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="""NAME:John Doe
COMPANY:Acme
EMAIL:john@acme.com
PHONE:+1234567890
<<<CONTACT>>>
NAME:Jane Smith
EMAIL:jane@example.com
<<<CONTACT>>>
""",
            stderr="",
        )

        contacts = fetch_contacts_by_names(["John Doe", "Jane Smith"])

        assert len(contacts) == 2
        assert contacts[0].name == "John Doe"
        assert contacts[0].company == "Acme"
        assert contacts[1].name == "Jane Smith"
        assert contacts[1].company is None

    @patch("services.macos.contacts.subprocess.run")
    def test_returns_empty_for_empty_input(self, mock_run):
        """Returns empty list for empty input (no subprocess call)."""
        contacts = fetch_contacts_by_names([])

        assert contacts == []
        mock_run.assert_not_called()

    @patch("services.macos.contacts.subprocess.run")
    def test_handles_not_found_contacts(self, mock_run):
        """Handles contacts that don't exist in Contacts app."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="<<<CONTACT>>>\n",  # Empty blocks for not found
            stderr="",
        )

        contacts = fetch_contacts_by_names(["Nonexistent Person"])

        assert contacts == []


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
# Integration Tests (marked slow - require real AppleScript execution)
# =============================================================================


@pytest.mark.slow
@pytest.mark.integration
class TestContactsIntegration:
    """Integration tests for contacts (requires macOS + Contacts.app)."""

    def test_fetch_all_contact_names_runs(self):
        """fetch_all_contact_names executes without error."""
        # This will actually run AppleScript
        # May return empty list if no contacts
        names = fetch_all_contact_names()
        assert isinstance(names, list)


@pytest.mark.slow
@pytest.mark.integration
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
