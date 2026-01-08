"""Tests for database layer."""

import os

from db import AppDb, ChatDb, sync_text_cache_full


class TestAppDb:
    """Tests for AppDb class."""

    def test_init_creates_database(self, app_db_path: str):
        """AppDb creates database file."""
        db = AppDb(app_db_path)
        db.init_schema()

        assert os.path.exists(app_db_path)
        db.close()

    def test_init_schema_creates_tables(self, app_db: AppDb):
        """init_schema creates all required tables."""
        with app_db.session() as session:
            # Check tables exist by querying sqlite_master
            from sqlmodel import text

            result = session.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            )
            tables = [row[0] for row in result]

        # New simplified schema - only text cache, actions, and LLM queue
        expected = [
            "actions",
            "llm_analysis_queue",
            "message_text_cache",
            "sync_state",
        ]
        for table in expected:
            assert table in tables, f"Missing table: {table}"


class TestChatDb:
    """Tests for ChatDb class (reading from chat.db)."""

    def test_get_all_chats(self, chat_db: ChatDb):
        """get_all_chats returns chats with last message."""
        chats = chat_db.get_all_chats()

        assert len(chats) == 2
        # Should be ordered by last message date DESC
        identifiers = [c.identifier for c in chats]
        assert "+11234567890" in identifiers
        assert "chat123456789" in identifiers

    def test_get_all_chats_identifies_groups(self, chat_db: ChatDb):
        """get_all_chats correctly identifies group chats."""
        chats = chat_db.get_all_chats()
        chat_map = {c.identifier: c for c in chats}

        assert chat_map["+11234567890"].is_group is False
        assert chat_map["chat123456789"].is_group is True

    def test_get_chat_messages(self, chat_db: ChatDb):
        """get_chat_messages returns messages for a chat."""
        messages = chat_db.get_chat_messages(chat_id=1, limit=100)

        assert len(messages) == 2
        # Should be ordered by date DESC
        texts = [m.text for m in messages]
        assert "Hi there!" in texts
        assert "Hello!" in texts

    def test_get_chat_messages_with_limit(self, chat_db: ChatDb):
        """get_chat_messages respects limit parameter."""
        messages = chat_db.get_chat_messages(chat_id=1, limit=1)

        assert len(messages) == 1

    def test_get_chat_participants(self, chat_db: ChatDb):
        """get_chat_participants returns handles for a chat."""
        # 1:1 chat
        participants = chat_db.get_chat_participants(chat_id=1)
        assert len(participants) == 1
        assert participants[0]["identifier"] == "+11234567890"

        # Group chat
        participants = chat_db.get_chat_participants(chat_id=2)
        assert len(participants) == 2

    def test_get_message_attachments(self, chat_db: ChatDb):
        """get_message_attachments returns attachments for a message."""
        attachments = chat_db.get_message_attachments(message_id=1)

        assert len(attachments) == 1
        assert attachments[0]["filename"] == "photo.jpg"
        assert attachments[0]["mime_type"] == "image/jpeg"

    def test_get_message_attachments_empty(self, chat_db: ChatDb):
        """get_message_attachments returns empty list for message without attachments."""
        attachments = chat_db.get_message_attachments(message_id=2)

        assert len(attachments) == 0


class TestSyncTextCacheFull:
    """Tests for sync_text_cache_full function (text cache sync)."""

    def test_sync_caches_messages(self, chat_db: ChatDb, app_db: AppDb):
        """sync_text_cache_full caches message text from chat.db."""
        stats = sync_text_cache_full(chat_db, app_db, verbose=False)

        # New sync only caches message text
        assert stats["cached_messages"] == 3

    def test_sync_returns_elapsed_time(self, chat_db: ChatDb, app_db: AppDb):
        """sync_text_cache_full returns elapsed time."""
        stats = sync_text_cache_full(chat_db, app_db, verbose=False)

        assert "elapsed" in stats
        assert stats["elapsed"] >= 0

    def test_sync_populates_text_cache(self, chat_db: ChatDb, app_db: AppDb):
        """sync_text_cache_full populates the message_text_cache table."""
        sync_text_cache_full(chat_db, app_db, verbose=False)

        cached_ids = app_db.get_all_cached_message_ids()
        assert len(cached_ids) == 3  # 3 messages with text

    def test_sync_updates_last_synced_rowid(self, chat_db: ChatDb, app_db: AppDb):
        """sync_text_cache_full updates the last synced ROWID."""
        sync_text_cache_full(chat_db, app_db, verbose=False)

        last_rowid = app_db.get_last_synced_rowid()
        assert last_rowid > 0


class TestTextCache:
    """Tests for text cache methods in AppDb."""

    def test_cache_message_text(self, app_db: AppDb):
        """cache_message_text stores text for a message."""
        app_db.cache_message_text(message_id=1, chat_id=1, msg_text="Hello world")

        text = app_db.get_cached_text(message_id=1)
        assert text == "Hello world"

    def test_get_cached_text_returns_none_for_missing(self, app_db: AppDb):
        """get_cached_text returns None for non-existent message."""
        text = app_db.get_cached_text(message_id=999)
        assert text is None

    def test_get_all_cached_message_ids(self, app_db: AppDb):
        """get_all_cached_message_ids returns all cached IDs."""
        app_db.cache_message_text(message_id=1, chat_id=1, msg_text="Hello")
        app_db.cache_message_text(message_id=2, chat_id=1, msg_text="World")

        ids = app_db.get_all_cached_message_ids()
        assert ids == {1, 2}

    def test_delete_cached_messages(self, app_db: AppDb):
        """delete_cached_messages removes entries from cache."""
        app_db.cache_message_text(message_id=1, chat_id=1, msg_text="Hello")
        app_db.cache_message_text(message_id=2, chat_id=1, msg_text="World")

        deleted = app_db.delete_cached_messages([1])
        assert deleted == 1

        ids = app_db.get_all_cached_message_ids()
        assert ids == {2}

    def test_cache_message_texts_batch(self, app_db: AppDb):
        """cache_message_texts_batch stores multiple messages efficiently."""
        messages = [
            (1, 1, "Hello"),
            (2, 1, "World"),
            (3, 2, "Foo"),
        ]
        app_db.cache_message_texts_batch(messages)

        ids = app_db.get_all_cached_message_ids()
        assert ids == {1, 2, 3}
