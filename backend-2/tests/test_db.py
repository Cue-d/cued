"""Tests for database layer."""


from db import AppDb, sync_all


class TestAppDb:
    """Tests for AppDb class."""

    def test_init_creates_database(self, app_db_path: str):
        """AppDb creates database file."""
        db = AppDb(app_db_path)
        db.init_schema()

        import os

        assert os.path.exists(app_db_path)
        db.close()

    def test_init_schema_creates_tables(self, app_db: AppDb):
        """init_schema creates all required tables."""
        with app_db.session() as session:
            # Check tables exist by querying sqlite_master
            from sqlmodel import text

            result = session.exec(
                text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            )
            tables = [row[0] for row in result]

        expected = [
            "attachments",
            "chat_participants",
            "chats",
            "handles",
            "messages",
        ]
        for table in expected:
            assert table in tables, f"Missing table: {table}"


class TestSyncAll:
    """Tests for sync_all function."""

    def test_sync_copies_handles(self, chat_db_path: str, app_db_path: str):
        """sync_all copies handles from chat.db."""
        stats = sync_all(chat_db_path, app_db_path, verbose=False)

        assert stats["handles"] == 3

        # Verify data in prm.db
        db = AppDb(app_db_path)
        with db.session() as session:
            from sqlmodel import text

            result = session.exec(text("SELECT COUNT(*) FROM handles"))
            assert result.fetchone()[0] == 3
        db.close()

    def test_sync_copies_chats(self, chat_db_path: str, app_db_path: str):
        """sync_all copies chats from chat.db."""
        stats = sync_all(chat_db_path, app_db_path, verbose=False)

        assert stats["chats"] == 2

    def test_sync_copies_messages(self, chat_db_path: str, app_db_path: str):
        """sync_all copies messages from chat.db."""
        stats = sync_all(chat_db_path, app_db_path, verbose=False)

        assert stats["messages"] == 3

    def test_sync_copies_participants(self, chat_db_path: str, app_db_path: str):
        """sync_all copies chat participants."""
        stats = sync_all(chat_db_path, app_db_path, verbose=False)

        assert stats["participants"] == 3

    def test_sync_returns_elapsed_time(self, chat_db_path: str, app_db_path: str):
        """sync_all returns elapsed time."""
        stats = sync_all(chat_db_path, app_db_path, verbose=False)

        assert "elapsed" in stats
        assert stats["elapsed"] >= 0


class TestAppDbQueries:
    """Tests for AppDb query methods."""

    def test_get_all_chats(self, chat_db_path: str, app_db_path: str):
        """get_all_chats returns chats with last message."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        chats = db.get_all_chats()

        assert len(chats) == 2
        # Should be ordered by last message date DESC
        assert chats[0].identifier in ["+11234567890", "chat123456789"]
        db.close()

    def test_get_all_chats_identifies_groups(self, chat_db_path: str, app_db_path: str):
        """get_all_chats correctly identifies group chats."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        chats = db.get_all_chats()
        chat_map = {c.identifier: c for c in chats}

        assert chat_map["+11234567890"].is_group is False
        assert chat_map["chat123456789"].is_group is True
        db.close()

    def test_get_chat_messages(self, chat_db_path: str, app_db_path: str):
        """get_chat_messages returns messages for a chat."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        messages = db.get_chat_messages(chat_id=1, limit=100)

        assert len(messages) == 2
        # Should be ordered by date DESC
        assert messages[0].text == "Hi there!"
        assert messages[1].text == "Hello!"
        db.close()

    def test_get_chat_messages_with_limit(self, chat_db_path: str, app_db_path: str):
        """get_chat_messages respects limit parameter."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        messages = db.get_chat_messages(chat_id=1, limit=1)

        assert len(messages) == 1
        db.close()

    def test_get_chat_participants(self, chat_db_path: str, app_db_path: str):
        """get_chat_participants returns handles for a chat."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        # 1:1 chat
        participants = db.get_chat_participants(chat_id=1)
        assert len(participants) == 1
        assert participants[0].identifier == "+11234567890"

        # Group chat
        participants = db.get_chat_participants(chat_id=2)
        assert len(participants) == 2
        db.close()

    def test_get_message_attachments(self, chat_db_path: str, app_db_path: str):
        """get_message_attachments returns attachments for a message."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        attachments = db.get_message_attachments(message_id=1)

        assert len(attachments) == 1
        assert attachments[0].filename == "photo.jpg"
        assert attachments[0].mime_type == "image/jpeg"
        db.close()

    def test_get_message_attachments_empty(self, chat_db_path: str, app_db_path: str):
        """get_message_attachments returns empty list for message without attachments."""
        sync_all(chat_db_path, app_db_path, verbose=False)
        db = AppDb(app_db_path)

        attachments = db.get_message_attachments(message_id=2)

        assert len(attachments) == 0
        db.close()
