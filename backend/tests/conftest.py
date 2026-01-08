"""Test fixtures for prm-backend."""

import os
import sqlite3
import tempfile
from collections.abc import Generator

import pytest

from db import AppDb, ChatDb


@pytest.fixture
def temp_dir() -> Generator[str, None, None]:
    """Create a temporary directory for test databases."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def chat_db_path(temp_dir: str) -> str:
    """Create a mock chat.db with sample data."""
    path = os.path.join(temp_dir, "chat.db")
    conn = sqlite3.connect(path)

    # Create tables (matching Apple's chat.db schema)
    conn.executescript("""
        CREATE TABLE handle (
            ROWID INTEGER PRIMARY KEY,
            id TEXT NOT NULL,
            service TEXT NOT NULL,
            uncanonicalized_id TEXT,
            person_centric_id TEXT
        );

        CREATE TABLE chat (
            ROWID INTEGER PRIMARY KEY,
            chat_identifier TEXT NOT NULL,
            display_name TEXT,
            style INTEGER DEFAULT 43,
            group_id TEXT,
            service_name TEXT
        );

        CREATE TABLE message (
            ROWID INTEGER PRIMARY KEY,
            handle_id INTEGER,
            text TEXT,
            attributedBody BLOB,
            date INTEGER DEFAULT 0,
            date_read INTEGER,
            date_delivered INTEGER,
            is_from_me INTEGER DEFAULT 0,
            is_read INTEGER DEFAULT 0,
            is_delivered INTEGER DEFAULT 0,
            is_sent INTEGER DEFAULT 0,
            cache_has_attachments INTEGER DEFAULT 0,
            error INTEGER DEFAULT 0,
            guid TEXT,
            service TEXT
        );

        CREATE TABLE attachment (
            ROWID INTEGER PRIMARY KEY,
            filename TEXT,
            mime_type TEXT,
            uti TEXT,
            transfer_name TEXT,
            total_bytes INTEGER,
            is_outgoing INTEGER DEFAULT 0,
            created_date INTEGER,
            guid TEXT
        );

        CREATE TABLE chat_handle_join (
            chat_id INTEGER NOT NULL,
            handle_id INTEGER NOT NULL,
            PRIMARY KEY (chat_id, handle_id)
        );

        CREATE TABLE chat_message_join (
            chat_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            PRIMARY KEY (chat_id, message_id)
        );

        CREATE TABLE message_attachment_join (
            message_id INTEGER NOT NULL,
            attachment_id INTEGER NOT NULL,
            PRIMARY KEY (message_id, attachment_id)
        );
    """)

    # Insert sample data
    conn.executescript("""
        -- Handles
        INSERT INTO handle (ROWID, id, service) VALUES
            (1, '+11234567890', 'iMessage'),
            (2, '+10987654321', 'iMessage'),
            (3, 'test@example.com', 'iMessage');

        -- Chats (is_group determined by participant count, not style)
        INSERT INTO chat (ROWID, chat_identifier, display_name, style) VALUES
            (1, '+11234567890', NULL, 45),
            (2, 'chat123456789', 'Family Group', 43);

        -- Messages (using Apple timestamp format: nanoseconds since 2001-01-01)
        -- 700000000000000000 ns = ~22 years = 2023
        INSERT INTO message (ROWID, handle_id, text, date, is_from_me, is_read) VALUES
            (1, 1, 'Hello!', 700000000000000000, 0, 1),
            (2, NULL, 'Hi there!', 700001000000000000, 1, 1),
            (3, 2, 'See you tomorrow', 700002000000000000, 0, 1);

        -- Chat participants
        INSERT INTO chat_handle_join (chat_id, handle_id) VALUES
            (1, 1),
            (2, 1),
            (2, 2);

        -- Chat messages
        INSERT INTO chat_message_join (chat_id, message_id) VALUES
            (1, 1),
            (1, 2),
            (2, 3);

        -- Attachments
        INSERT INTO attachment (ROWID, filename, mime_type, total_bytes, is_outgoing) VALUES
            (1, 'photo.jpg', 'image/jpeg', 12345, 0);

        INSERT INTO message_attachment_join (message_id, attachment_id) VALUES
            (1, 1);
    """)

    conn.commit()
    conn.close()
    return path


@pytest.fixture
def app_db_path(temp_dir: str) -> str:
    """Return path for test prm.db."""
    return os.path.join(temp_dir, "prm.db")


@pytest.fixture
def app_db(app_db_path: str) -> Generator[AppDb, None, None]:
    """Create an AppDb instance with initialized schema."""
    db = AppDb(app_db_path)
    db.init_schema()
    yield db
    db.close()


@pytest.fixture
def chat_db(chat_db_path: str) -> Generator[ChatDb, None, None]:
    """Create a ChatDb instance for reading test chat.db."""
    db = ChatDb(chat_db_path)
    yield db
    db.close()
