"""Sync from chat.db to prm.db with schema mapping."""

import sqlite3
import time

from sqlmodel import text

from .prm_db import AppDb
from services.attributed_body import extract_text_from_attributed_body

# Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
APPLE_EPOCH_OFFSET = 978307200


def apple_to_unix(apple_ts: int | None) -> int | None:
    """Convert Apple nanosecond timestamp to Unix seconds."""
    if apple_ts is None or apple_ts == 0:
        return None
    return (apple_ts // 1_000_000_000) + APPLE_EPOCH_OFFSET


def get_message_text(text_col: str | None, attributed_body: bytes | None) -> str | None:
    """Get message text, falling back to attributedBody extraction if text is null."""
    if text_col:
        return text_col
    if attributed_body:
        return extract_text_from_attributed_body(attributed_body)
    return None


def sync_all(chat_db_path: str, app_db_path: str, verbose: bool = True) -> dict:
    """
    Sync from chat.db to prm.db with schema mapping.

    Maps chat.db tables to prm.db schema:
    - handle -> handles (with name resolution)
    - chat -> chats (with is_group computed from style)
    - chat_handle_join -> chat_participants
    - message + chat_message_join -> messages (with timestamp conversion)
    - attachment + message_attachment_join -> attachments
    """
    start = time.time()
    now = int(time.time())

    if verbose:
        print("=" * 60)
        print("Syncing chat.db → prm.db")
        print("=" * 60)

    # Open chat.db read-only
    src = sqlite3.connect(f"file:{chat_db_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row

    # Create/open prm.db
    app = AppDb(app_db_path)
    app.init_schema()

    stats = {"handles": 0, "chats": 0, "participants": 0, "messages": 0, "attachments": 0}

    with app.session() as session:
        # 1. Sync handles -> handles
        if verbose:
            print("\n1. Syncing handles...")

        rows = src.execute("SELECT ROWID, id, service FROM handle").fetchall()
        for row in rows:
            session.exec(
                text("""
                    INSERT OR REPLACE INTO handles (id, identifier, service)
                    VALUES (:id, :identifier, :service)
                """).bindparams(
                    id=row["ROWID"],
                    identifier=row["id"],
                    service=row["service"],
                )
            )
            stats["handles"] += 1

        if verbose:
            print(f"   ✓ {stats['handles']} handles")

        # 2. Sync chat -> chats (with participant count for is_group)
        if verbose:
            print("\n2. Syncing chats...")

        # Get participant counts per chat
        participant_counts = {}
        for row in src.execute(
            "SELECT chat_id, COUNT(*) as cnt FROM chat_handle_join GROUP BY chat_id"
        ).fetchall():
            participant_counts[row["chat_id"]] = row["cnt"]

        rows = src.execute("SELECT ROWID, chat_identifier, display_name FROM chat").fetchall()
        for row in rows:
            is_group = participant_counts.get(row["ROWID"], 0) > 1
            name = row["display_name"] or row["chat_identifier"]
            session.exec(
                text("""
                    INSERT OR REPLACE INTO chats (id, identifier, name, is_group, synced_at)
                    VALUES (:id, :identifier, :name, :is_group, :synced_at)
                """).bindparams(
                    id=row["ROWID"],
                    identifier=row["chat_identifier"],
                    name=name,
                    is_group=is_group,
                    synced_at=now,
                )
            )
            stats["chats"] += 1

        if verbose:
            print(f"   ✓ {stats['chats']} chats")

        # 3. Sync chat_handle_join -> chat_participants
        if verbose:
            print("\n3. Syncing participants...")

        session.exec(text("DELETE FROM chat_participants"))
        rows = src.execute("SELECT chat_id, handle_id FROM chat_handle_join").fetchall()
        for row in rows:
            session.exec(
                text("""
                    INSERT OR IGNORE INTO chat_participants (chat_id, handle_id)
                    VALUES (:chat_id, :handle_id)
                """).bindparams(
                    chat_id=row["chat_id"],
                    handle_id=row["handle_id"],
                )
            )
            stats["participants"] += 1

        if verbose:
            print(f"   ✓ {stats['participants']} participants")

        # 4. Sync messages (joining message + chat_message_join)
        if verbose:
            print("\n4. Syncing messages...")

        rows = src.execute("""
            SELECT m.ROWID, cmj.chat_id, m.handle_id, m.text, m.attributedBody,
                   m.date, m.is_from_me, m.is_read, m.date_read, m.cache_has_attachments
            FROM message m
            INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        """).fetchall()

        for row in rows:
            # handle_id=0 means no handle (system message), convert to None
            handle_id = row["handle_id"]
            sender_id = handle_id if handle_id and not row["is_from_me"] else None

            # Extract text from attributedBody if text column is null
            message_text = get_message_text(row["text"], row["attributedBody"])

            session.exec(
                text("""
                    INSERT OR REPLACE INTO messages
                    (id, chat_id, sender_id, text, timestamp, is_from_me, is_read,
                     read_at, has_attachments, synced_at)
                    VALUES (:id, :chat_id, :sender_id, :text, :timestamp, :is_from_me,
                            :is_read, :read_at, :has_attachments, :synced_at)
                """).bindparams(
                    id=row["ROWID"],
                    chat_id=row["chat_id"],
                    sender_id=sender_id,
                    text=message_text,
                    timestamp=apple_to_unix(row["date"]) or 0,
                    is_from_me=bool(row["is_from_me"]),
                    is_read=bool(row["is_read"]),
                    read_at=apple_to_unix(row["date_read"]),
                    has_attachments=bool(row["cache_has_attachments"]),
                    synced_at=now,
                )
            )
            stats["messages"] += 1

            if verbose and stats["messages"] % 10000 == 0:
                print(f"   ... {stats['messages']} messages")

        if verbose:
            print(f"   ✓ {stats['messages']} messages")

        # 5. Sync attachments (joining attachment + message_attachment_join)
        if verbose:
            print("\n5. Syncing attachments...")

        rows = src.execute("""
            SELECT a.ROWID, maj.message_id, a.filename, a.mime_type, a.uti,
                   a.total_bytes, a.is_outgoing, a.created_date
            FROM attachment a
            INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
        """).fetchall()

        for row in rows:
            session.exec(
                text("""
                    INSERT OR REPLACE INTO attachments
                    (id, message_id, filename, path, mime_type, uti, size,
                     is_outgoing, created_at, synced_at)
                    VALUES (:id, :message_id, :filename, :path, :mime_type, :uti,
                            :size, :is_outgoing, :created_at, :synced_at)
                """).bindparams(
                    id=row["ROWID"],
                    message_id=row["message_id"],
                    filename=row["filename"],
                    path=row["filename"],  # path = filename for now
                    mime_type=row["mime_type"],
                    uti=row["uti"],
                    size=row["total_bytes"],
                    is_outgoing=bool(row["is_outgoing"]),
                    created_at=apple_to_unix(row["created_date"]),
                    synced_at=now,
                )
            )
            stats["attachments"] += 1

        if verbose:
            print(f"   ✓ {stats['attachments']} attachments")

        session.commit()

    src.close()
    app.close()

    elapsed = time.time() - start
    if verbose:
        print("\n" + "=" * 60)
        print(f"Done in {elapsed:.2f}s")
        print("=" * 60)

    return {**stats, "elapsed": elapsed}
