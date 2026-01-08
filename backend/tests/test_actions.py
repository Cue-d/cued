"""Tests for actions router and database operations."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from db.prm_db import AppDb
from main import app


@pytest.fixture
def client():
    """Test client for FastAPI app."""
    return TestClient(app)


@pytest.fixture
def test_db(tmp_path):
    """Create a test database with schema."""
    db_path = str(tmp_path / "test_prm.db")
    db = AppDb(db_path)
    db.init_schema()
    return db


class TestActionsCRUD:
    """Test action CRUD operations."""

    def test_create_action(self, test_db):
        """Test creating a new action."""
        db = test_db
        action_id = db.create_action(
            action_type="respond_to_message",
            priority=60,
            chat_id=1,
            person_id=1,
            message_id=3,
            payload=json.dumps({"message_preview": "How are you?"}),
        )

        assert action_id is not None
        assert action_id > 0

    def test_get_action(self, test_db):
        """Test retrieving a single action."""
        db = test_db
        action_id = db.create_action(
            action_type="respond_to_message",
            priority=60,
            chat_id=1,
        )

        action = db.get_action(action_id)
        assert action is not None
        assert action.id == action_id
        assert action.type == "respond_to_message"
        assert action.status == "pending"
        assert action.priority == 60
        assert action.chat_id == 1
        # Note: chat_name is now populated by ChatDb, not stored in actions table
        assert action.chat_name is None

    def test_get_action_not_found(self, test_db):
        """Test retrieving nonexistent action."""
        db = test_db
        action = db.get_action(9999)
        assert action is None

    def test_get_pending_actions(self, test_db):
        """Test getting pending actions ordered by priority."""
        db = test_db

        # Create actions with different priorities
        db.create_action(action_type="respond_to_message", priority=50, chat_id=1)
        db.create_action(action_type="respond_to_message", priority=80, chat_id=1)
        db.create_action(action_type="follow_up", priority=60, chat_id=1)

        actions = db.get_pending_actions()
        assert len(actions) == 3
        # Should be ordered by priority DESC
        assert actions[0].priority == 80
        assert actions[1].priority == 60
        assert actions[2].priority == 50

    def test_get_pending_actions_includes_expired_snoozed(self, test_db):
        """Test that expired snoozed actions appear in pending list."""
        db = test_db

        action_id = db.create_action(action_type="respond_to_message", priority=50, chat_id=1)
        # Snooze until the past
        db.update_action_status(action_id, "snoozed", int(time.time()) - 60)

        actions = db.get_pending_actions()
        assert len(actions) == 1
        assert actions[0].status == "snoozed"

    def test_update_action_status_to_completed(self, test_db):
        """Test marking action as completed."""
        db = test_db
        action_id = db.create_action(action_type="respond_to_message", chat_id=1)

        db.update_action_status(action_id, "completed")

        action = db.get_action(action_id)
        assert action.status == "completed"
        assert action.completed_at is not None
        assert action.discarded_at is None

    def test_update_action_status_to_discarded(self, test_db):
        """Test marking action as discarded."""
        db = test_db
        action_id = db.create_action(action_type="respond_to_message", chat_id=1)

        db.update_action_status(action_id, "discarded")

        action = db.get_action(action_id)
        assert action.status == "discarded"
        assert action.discarded_at is not None
        assert action.completed_at is None

    def test_update_action_status_to_snoozed(self, test_db):
        """Test snoozing an action."""
        db = test_db
        action_id = db.create_action(action_type="respond_to_message", chat_id=1)
        snooze_until = int(time.time()) + 3600

        db.update_action_status(action_id, "snoozed", snooze_until)

        action = db.get_action(action_id)
        assert action.status == "snoozed"
        assert action.snoozed_until == snooze_until

    def test_delete_action(self, test_db):
        """Test deleting an action."""
        db = test_db
        action_id = db.create_action(action_type="respond_to_message", chat_id=1)

        db.delete_action(action_id)

        action = db.get_action(action_id)
        assert action is None


class TestLlmAnalysisQueue:
    """Test LLM analysis queue operations."""

    def test_queue_for_analysis(self, test_db):
        """Test queueing a chat for analysis."""
        db = test_db
        db.queue_for_analysis(chat_id=1, priority=75)

        item = db.get_next_pending_analysis()
        assert item is not None
        assert item.chat_id == 1
        assert item.priority == 75
        assert item.status == "pending"

    def test_get_next_pending_analysis_priority_order(self, test_db):
        """Test that highest priority item is returned first."""
        db = test_db

        db.queue_for_analysis(chat_id=1, priority=50)
        db.queue_for_analysis(chat_id=2, priority=80)

        item = db.get_next_pending_analysis()
        assert item.chat_id == 2
        assert item.priority == 80

    def test_mark_analysis_started(self, test_db):
        """Test marking analysis as started."""
        db = test_db
        db.queue_for_analysis(chat_id=1, priority=50)

        db.mark_analysis_started(chat_id=1)

        # Should not appear in pending anymore
        item = db.get_next_pending_analysis()
        assert item is None

    def test_mark_analysis_complete(self, test_db):
        """Test marking analysis as complete."""
        db = test_db
        db.queue_for_analysis(chat_id=1, priority=50)
        db.mark_analysis_started(chat_id=1)

        db.mark_analysis_complete(chat_id=1, result="action_created")

        # Verify it's marked complete (not in pending)
        item = db.get_next_pending_analysis()
        assert item is None

    def test_mark_analysis_skipped(self, test_db):
        """Test marking chat as skipped."""
        db = test_db
        db.mark_analysis_skipped(chat_id=1, reason="short_code_sender")

        # Should not appear in pending
        item = db.get_next_pending_analysis()
        assert item is None

    def test_clear_old_analysis(self, test_db):
        """Test clearing old completed analysis entries."""
        db = test_db
        db.queue_for_analysis(chat_id=1, priority=50)
        db.mark_analysis_complete(chat_id=1, result="no_action")

        # hours_old=1 means entries completed more than 1 hour ago
        # Since we just completed it, it won't be cleared
        cleared = db.clear_old_analysis(hours_old=1)
        assert cleared == 0

        # But it should still exist in the queue (just not pending)
        item = db.get_next_pending_analysis()
        assert item is None  # Not pending anymore


class TestMessageFilter:
    """Test message filter heuristics."""

    def test_short_code_filter(self):
        """Test short code sender detection."""
        from services.actions.message_filter import should_skip_llm_analysis

        result = should_skip_llm_analysis(
            identifier="12345", text="Hello", person_name=None, is_contact=False
        )
        assert result.should_skip is True
        assert result.reason.value == "short_code_sender"

    def test_otp_filter(self):
        """Test OTP message detection."""
        from services.actions.message_filter import should_skip_llm_analysis

        result = should_skip_llm_analysis(
            identifier="+15551234567",
            text="Your verification code is 123456",
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason.value == "otp_verification_code"

    def test_unsubscribe_filter(self):
        """Test marketing unsubscribe detection."""
        from services.actions.message_filter import should_skip_llm_analysis

        result = should_skip_llm_analysis(
            identifier="+15551234567",
            text="50% off! Reply STOP to unsubscribe",
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason.value == "marketing_with_unsubscribe"

    def test_normal_message_not_filtered(self):
        """Test that normal messages are not filtered."""
        from services.actions.message_filter import should_skip_llm_analysis

        result = should_skip_llm_analysis(
            identifier="+15551234567",
            text="Hey, want to grab lunch tomorrow?",
            person_name="John Smith",
            is_contact=True,
        )
        assert result.should_skip is False


class TestPriorityCalculation:
    """Test priority scoring."""

    def test_fresh_message_low_priority(self):
        """Test that very fresh messages have low priority."""
        from services.actions.priority import calculate_chat_priority

        priority = calculate_chat_priority(hours_since=1)
        assert priority == 20

    def test_peak_urgency_zone(self):
        """Test that 24-72h messages have peak priority."""
        from services.actions.priority import calculate_chat_priority

        priority = calculate_chat_priority(hours_since=48)
        assert priority == 80

    def test_contact_boost(self):
        """Test contact importance boost."""
        from services.actions.priority import calculate_chat_priority

        priority = calculate_chat_priority(
            hours_since=48, person={"is_contact": True, "company": "Acme Inc"}
        )
        # Base 80 + 10 (contact) + 10 (company) = 100
        assert priority == 100

    def test_group_penalty(self):
        """Test group chat penalty."""
        from services.actions.priority import calculate_chat_priority

        priority = calculate_chat_priority(hours_since=48, is_group=True)
        # Base 80 - 15 (group) = 65
        assert priority == 65


class TestLlmClient:
    """Test LLM client utilities."""

    def test_sanitize_text(self):
        """Test text sanitization."""
        from services.actions.llm_client import sanitize_text

        # Normal text passes through
        assert sanitize_text("Hello world") == "Hello world"

        # None returns empty string
        assert sanitize_text(None) == ""

        # Control characters are removed
        assert sanitize_text("Hello\x00world") == "Helloworld"

        # Newlines are preserved
        assert sanitize_text("Hello\nworld") == "Hello\nworld"

    def test_sanitize_text_truncates_long_text(self):
        """Test that long text is truncated."""
        from services.actions.llm_client import sanitize_text

        long_text = "x" * 2000
        result = sanitize_text(long_text)
        assert len(result) == 1003  # 1000 + "..."
        assert result.endswith("...")

    def test_format_conversation(self):
        """Test conversation formatting."""
        from services.actions.llm_client import (
            ConversationContext,
            format_conversation_as_text,
        )

        ctx = ConversationContext(
            chat_id=1,
            person_id=1,
            person_name="John Doe",
            person_company="Acme Inc",
            person_notes="Met at conference",
            messages=[
                {"text": "Hello", "is_from_me": False, "timestamp": 1000},
                {"text": "Hi there", "is_from_me": True, "timestamp": 2000},
            ],
            hours_since_last=24,
        )

        result = format_conversation_as_text(ctx)
        assert "John Doe" in result
        assert "Acme Inc" in result
        assert "Met at conference" in result
        assert "Hours since last message: 24" in result
        assert "Them: Hello" in result
        assert "Me: Hi there" in result
