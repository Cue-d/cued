"""Tests for the LLM client."""

import json
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from services.llm_client import (
    ActionSuggestion,
    ConversationContext,
    LLMError,
    analyze_conversation,
    format_conversation_as_text,
    generate_actions,
    is_llm_available,
    sanitize_text,
)


# Sample conversation context for testing
@pytest.fixture
def sample_context() -> ConversationContext:
    return ConversationContext(
        chat_id=1,
        person_id=42,
        person_name="John Doe",
        person_company="Acme Corp",
        person_notes="Met at conference",
        messages=[
            {"text": "Hey, how are you?", "is_from_me": False, "timestamp": 1000000},
            {"text": "Good! What's up?", "is_from_me": True, "timestamp": 1000001},
            {"text": "Can you help me with something?", "is_from_me": False, "timestamp": 1000002},
        ],
        hours_since_last=24,
    )


@pytest.fixture
def sample_context_minimal() -> ConversationContext:
    """Context with minimal info (no person details)."""
    return ConversationContext(
        chat_id=2,
        person_id=None,
        person_name=None,
        person_company=None,
        person_notes=None,
        messages=[
            {"text": "Hello", "is_from_me": False, "timestamp": 1000000},
        ],
        hours_since_last=48,
    )


class TestSanitizeText:
    """Tests for sanitize_text function."""

    def test_returns_empty_for_none(self):
        assert sanitize_text(None) == ""

    def test_returns_empty_for_empty_string(self):
        assert sanitize_text("") == ""

    def test_preserves_normal_text(self):
        assert sanitize_text("Hello, world!") == "Hello, world!"

    def test_preserves_newlines_and_tabs(self):
        assert sanitize_text("Line 1\nLine 2\tTabbed") == "Line 1\nLine 2\tTabbed"

    def test_removes_null_bytes(self):
        assert sanitize_text("Hello\x00World") == "HelloWorld"

    def test_removes_control_characters(self):
        # Control characters 0x00-0x1F except \n, \r, \t
        text_with_controls = "Hello\x01\x02\x03World"
        assert sanitize_text(text_with_controls) == "HelloWorld"

    def test_preserves_emoji(self):
        assert sanitize_text("Hello 👋 World 🌍") == "Hello 👋 World 🌍"

    def test_preserves_unicode(self):
        assert sanitize_text("Café résumé naïve") == "Café résumé naïve"

    def test_truncates_long_text(self):
        long_text = "x" * 2000
        result = sanitize_text(long_text)
        assert len(result) == 1003  # 1000 chars + "..."
        assert result.endswith("...")


class TestFormatConversationAsText:
    """Tests for format_conversation_as_text function."""

    def test_formats_full_context(self, sample_context: ConversationContext):
        result = format_conversation_as_text(sample_context)

        assert "Contact: John Doe (Acme Corp)" in result
        assert "Notes: Met at conference" in result
        assert "Hours since last message: 24" in result
        assert "Them: Hey, how are you?" in result
        assert "Me: Good! What's up?" in result
        assert "Them: Can you help me with something?" in result

    def test_formats_minimal_context(self, sample_context_minimal: ConversationContext):
        result = format_conversation_as_text(sample_context_minimal)

        # Should not have contact line
        assert "Contact:" not in result
        assert "Notes:" not in result
        assert "Hours since last message: 48" in result
        assert "Them: Hello" in result

    def test_handles_attachment_messages(self):
        ctx = ConversationContext(
            chat_id=1,
            person_id=None,
            person_name="Test",
            person_company=None,
            person_notes=None,
            messages=[{"text": None, "is_from_me": False, "timestamp": 1000000}],
            hours_since_last=1,
        )
        result = format_conversation_as_text(ctx)

        assert "[attachment]" in result

    def test_limits_to_last_10_messages(self):
        messages = [
            {"text": f"Message {i}", "is_from_me": i % 2 == 0, "timestamp": 1000000 + i}
            for i in range(15)
        ]
        ctx = ConversationContext(
            chat_id=1,
            person_id=None,
            person_name=None,
            person_company=None,
            person_notes=None,
            messages=messages,
            hours_since_last=1,
        )
        result = format_conversation_as_text(ctx)

        # Should only have messages 5-14 (last 10)
        assert "Message 0" not in result
        assert "Message 4" not in result
        assert "Message 5" in result
        assert "Message 14" in result


class TestAnalyzeConversation:
    """Tests for analyze_conversation with mocked subprocess."""

    def test_returns_action_suggestion_when_action_needed(
        self, sample_context: ConversationContext
    ):
        mock_output = {
            "action": {
                "type": "respond_to_message",
                "priority": 70,
                "payload": {"reason": "Unanswered question"},
                "remind_at": None,
            }
        }

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps(mock_output)
        mock_result.stderr = ""

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("subprocess.run", return_value=mock_result),
        ):
            result = analyze_conversation(sample_context)

        assert result is not None
        assert result.chat_id == 1
        assert result.action_type == "respond_to_message"
        assert result.priority == 70
        assert result.reason == "Unanswered question"

    def test_returns_none_when_no_action_needed(self, sample_context: ConversationContext):
        mock_output = {"action": None}

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps(mock_output)
        mock_result.stderr = ""

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("subprocess.run", return_value=mock_result),
        ):
            result = analyze_conversation(sample_context)

        assert result is None

    def test_raises_error_when_binary_not_available(self, sample_context: ConversationContext):
        with patch("services.llm_client.is_llm_available", return_value=False):
            with pytest.raises(LLMError, match="LLM binary not found"):
                analyze_conversation(sample_context)

    def test_raises_error_on_subprocess_failure(self, sample_context: ConversationContext):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "Model not available"
        mock_result.stdout = ""

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("subprocess.run", return_value=mock_result),
        ):
            with pytest.raises(LLMError, match="LLM call failed"):
                analyze_conversation(sample_context)

    def test_raises_content_safety_error_on_unsafe_content(
        self, sample_context: ConversationContext
    ):
        from services.llm_client import ContentSafetyError

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "Detected content likely to be unsafe"
        mock_result.stdout = ""

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("subprocess.run", return_value=mock_result),
        ):
            with pytest.raises(ContentSafetyError, match="Content flagged as unsafe"):
                analyze_conversation(sample_context)

    def test_raises_error_on_invalid_json(self, sample_context: ConversationContext):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "not valid json"
        mock_result.stderr = ""

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("subprocess.run", return_value=mock_result),
        ):
            with pytest.raises(LLMError, match="Invalid LLM output"):
                analyze_conversation(sample_context)

    def test_raises_error_on_timeout(self, sample_context: ConversationContext):
        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch(
                "subprocess.run",
                side_effect=subprocess.TimeoutExpired("prm-llm", 30),
            ),
        ):
            with pytest.raises(LLMError, match="timed out"):
                analyze_conversation(sample_context)


class TestGenerateActions:
    """Tests for generate_actions with multiple conversations."""

    def test_returns_empty_list_for_empty_input(self):
        result = generate_actions([])
        assert result == []

    def test_generates_actions_for_multiple_conversations(self):
        contexts = [
            ConversationContext(
                chat_id=1,
                person_id=1,
                person_name="Person 1",
                person_company=None,
                person_notes=None,
                messages=[{"text": "Question?", "is_from_me": False, "timestamp": 1000}],
                hours_since_last=24,
            ),
            ConversationContext(
                chat_id=2,
                person_id=2,
                person_name="Person 2",
                person_company=None,
                person_notes=None,
                messages=[{"text": "Thanks!", "is_from_me": False, "timestamp": 1000}],
                hours_since_last=1,
            ),
        ]

        # First conversation needs action, second doesn't
        def mock_analyze(ctx):
            if ctx.chat_id == 1:
                return ActionSuggestion(
                    chat_id=1,
                    action_type="respond_to_message",
                    priority=60,
                    reason="Unanswered question",
                )
            return None

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("services.llm_client.analyze_conversation", side_effect=mock_analyze),
        ):
            results = generate_actions(contexts)

        assert len(results) == 1
        assert results[0].chat_id == 1
        assert results[0].action_type == "respond_to_message"

    def test_continues_on_individual_failures(self):
        contexts = [
            ConversationContext(
                chat_id=1,
                person_id=1,
                person_name="P1",
                person_company=None,
                person_notes=None,
                messages=[],
                hours_since_last=1,
            ),
            ConversationContext(
                chat_id=2,
                person_id=2,
                person_name="P2",
                person_company=None,
                person_notes=None,
                messages=[],
                hours_since_last=1,
            ),
        ]

        call_count = 0

        def mock_analyze(ctx):
            nonlocal call_count
            call_count += 1
            if ctx.chat_id == 1:
                raise LLMError("Failed for chat 1")
            return ActionSuggestion(
                chat_id=2,
                action_type="follow_up",
                priority=50,
                reason="Test",
            )

        with (
            patch("services.llm_client.is_llm_available", return_value=True),
            patch("services.llm_client.analyze_conversation", side_effect=mock_analyze),
        ):
            results = generate_actions(contexts)

        assert call_count == 2  # Both were attempted
        assert len(results) == 1
        assert results[0].chat_id == 2


class TestIsLLMAvailable:
    """Tests for is_llm_available function."""

    def test_returns_false_when_binary_missing(self, tmp_path):
        fake_path = tmp_path / "nonexistent" / "prm-llm"
        with patch("services.llm_client.get_llm_binary_path", return_value=fake_path):
            assert is_llm_available() is False

    def test_returns_true_when_binary_exists_and_executable(self, tmp_path):
        # Create a fake executable
        fake_binary = tmp_path / "prm-llm"
        fake_binary.touch()
        fake_binary.chmod(0o755)

        with patch("services.llm_client.get_llm_binary_path", return_value=fake_binary):
            assert is_llm_available() is True


class TestLLMIntegration:
    """Integration tests that run if the actual binary is available.

    These tests are skipped if the prm-llm binary is not built.
    """

    @pytest.fixture
    def skip_if_no_binary(self):
        if not is_llm_available():
            pytest.skip("prm-llm binary not available (run: cd llm && swift build -c release)")

    def test_binary_accepts_text_input(self, skip_if_no_binary, sample_context):
        """Test that the binary accepts text input and returns valid JSON."""
        from services.llm_client import format_conversation_as_text, get_llm_binary_path

        text = format_conversation_as_text(sample_context)
        binary_path = get_llm_binary_path()

        # This will likely fail with "unsupported OS" on macOS < 26,
        # but we're testing that the binary runs and returns valid JSON/error
        result = subprocess.run(
            [str(binary_path)],
            input=text,
            capture_output=True,
            text=True,
            timeout=30,
        )

        # Should either succeed with JSON or fail with error message
        if result.returncode == 0:
            output = json.loads(result.stdout)
            assert "action" in output
        else:
            # stderr may contain retry messages plus JSON error
            # Just verify we got some error output
            assert result.stderr, "Expected error output on non-zero exit"
            # Try to find JSON error in stderr (may be mixed with retry messages)
            stderr_lines = result.stderr.strip().split("\n")
            found_json_error = False
            for line in stderr_lines:
                try:
                    error = json.loads(line)
                    if "error" in error:
                        found_json_error = True
                        break
                except json.JSONDecodeError:
                    continue
            # If no JSON error found, at least check for error text
            assert found_json_error or "error" in result.stderr.lower()
