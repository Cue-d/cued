"""Sync from chat.db to prm.db with schema mapping."""

import logging
import sqlite3
import time

from sqlmodel import text

from services.attributed_body import extract_text_from_attributed_body

from .prm_db import AppDb

logger = logging.getLogger(__name__)

# Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
APPLE_EPOCH_OFFSET = 978307200


def apple_to_unix(apple_ts: int | None) -> int | None:
    """Convert Apple nanosecond timestamp to Unix seconds."""
    if apple_ts is None or apple_ts == 0:
        return None
    return (apple_ts // 1_000_000_000) + APPLE_EPOCH_OFFSET


def unix_to_apple(unix_ts: int | None) -> int | None:
    """Convert Unix timestamp (seconds) to Apple nanosecond timestamp."""
    if unix_ts is None or unix_ts == 0:
        return None
    return (unix_ts - APPLE_EPOCH_OFFSET) * 1_000_000_000


def get_message_text(text_col: str | None, attributed_body: bytes | None) -> str | None:
    """Get message text, falling back to attributedBody extraction if text is null."""
    if text_col:
        return text_col
    if attributed_body:
        return extract_text_from_attributed_body(attributed_body)
    return None


def get_last_sync_timestamp(app_db_path: str) -> int | None:
    """Get the maximum message timestamp from prm.db for incremental sync."""
    try:
        app = AppDb(app_db_path)
        with app.session() as session:
            result = session.execute(text("SELECT MAX(timestamp) FROM messages"))
            row = result.fetchone()
            app.close()
            return row[0] if row and row[0] else None
    except Exception:
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


def sync_incremental(
    chat_db_path: str,
    app_db_path: str,
    since_timestamp: int | None = None,
    verbose: bool = False,
) -> dict:
    """
    Incremental sync from chat.db to prm.db - only syncs new/updated messages.

    This is much faster than sync_all() for periodic background syncs.
    Only processes messages with date > since_timestamp.

    Falls back to full sync if since_timestamp is None and no data exists.

    Args:
        chat_db_path: Path to Apple's chat.db
        app_db_path: Path to prm.db
        since_timestamp: Unix timestamp to sync from (exclusive). If None, auto-detects.
        verbose: Print progress to stdout

    Returns:
        dict with stats: messages, attachments, elapsed time
    """
    start = time.time()
    now = int(time.time())

    # Auto-detect last sync timestamp if not provided
    if since_timestamp is None:
        since_timestamp = get_last_sync_timestamp(app_db_path)

    # If still None (empty database), fall back to full sync
    if since_timestamp is None:
        if verbose:
            print("No existing data found, performing full sync...")
        return sync_all(chat_db_path, app_db_path, verbose=verbose)

    # Convert to Apple timestamp for query
    since_apple_ts = unix_to_apple(since_timestamp)

    if verbose:
        print(f"Incremental sync: messages since timestamp {since_timestamp}")

    # Open chat.db read-only
    src = sqlite3.connect(f"file:{chat_db_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row

    # Open prm.db
    app = AppDb(app_db_path)
    app.init_schema()

    stats = {"messages": 0, "attachments": 0, "handles": 0, "chats": 0}
    new_message_ids = set()

    with app.session() as session:
        # 1. Fetch only new messages (date > since_apple_ts)
        rows = src.execute(
            """
            SELECT m.ROWID, cmj.chat_id, m.handle_id, m.text, m.attributedBody,
                   m.date, m.is_from_me, m.is_read, m.date_read, m.cache_has_attachments
            FROM message m
            INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            WHERE m.date > ?
            ORDER BY m.date ASC
            """,
            (since_apple_ts,),
        ).fetchall()

        if not rows:
            src.close()
            app.close()
            return {"messages": 0, "attachments": 0, "elapsed": time.time() - start}

        if verbose:
            print(f"Found {len(rows)} new messages")

        # Collect unique handle_ids and chat_ids we need to ensure exist
        handle_ids = set()
        chat_ids = set()
        for row in rows:
            if row["handle_id"] and row["handle_id"] > 0:
                handle_ids.add(row["handle_id"])
            chat_ids.add(row["chat_id"])

        # 2. Sync any handles we reference (incremental - only missing ones)
        if handle_ids:
            placeholders = ",".join("?" * len(handle_ids))
            handle_rows = src.execute(
                f"SELECT ROWID, id, service FROM handle WHERE ROWID IN ({placeholders})",
                tuple(handle_ids),
            ).fetchall()

            for row in handle_rows:
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

        # 3. Sync any chats we reference (incremental)
        if chat_ids:
            # Get participant counts for is_group determination
            participant_counts = {}
            for row in src.execute(
                "SELECT chat_id, COUNT(*) as cnt FROM chat_handle_join GROUP BY chat_id"
            ).fetchall():
                participant_counts[row["chat_id"]] = row["cnt"]

            placeholders = ",".join("?" * len(chat_ids))
            chat_query = (
                f"SELECT ROWID, chat_identifier, display_name "
                f"FROM chat WHERE ROWID IN ({placeholders})"
            )
            chat_rows = src.execute(chat_query, tuple(chat_ids)).fetchall()

            for row in chat_rows:
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

            # Also sync participants for these chats
            participant_query = (
                f"SELECT chat_id, handle_id FROM chat_handle_join WHERE chat_id IN ({placeholders})"
            )
            participant_rows = src.execute(participant_query, tuple(chat_ids)).fetchall()

            for row in participant_rows:
                session.exec(
                    text("""
                        INSERT OR IGNORE INTO chat_participants (chat_id, handle_id)
                        VALUES (:chat_id, :handle_id)
                    """).bindparams(
                        chat_id=row["chat_id"],
                        handle_id=row["handle_id"],
                    )
                )

        # 4. Insert new messages
        for row in rows:
            handle_id = row["handle_id"]
            sender_id = handle_id if handle_id and not row["is_from_me"] else None
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
            new_message_ids.add(row["ROWID"])

        # 5. Sync attachments for new messages only
        if new_message_ids:
            placeholders = ",".join("?" * len(new_message_ids))
            attachment_rows = src.execute(
                f"""
                SELECT a.ROWID, maj.message_id, a.filename, a.mime_type, a.uti,
                       a.total_bytes, a.is_outgoing, a.created_date
                FROM attachment a
                INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                WHERE maj.message_id IN ({placeholders})
                """,
                tuple(new_message_ids),
            ).fetchall()

            for row in attachment_rows:
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
                        path=row["filename"],
                        mime_type=row["mime_type"],
                        uti=row["uti"],
                        size=row["total_bytes"],
                        is_outgoing=bool(row["is_outgoing"]),
                        created_at=apple_to_unix(row["created_date"]),
                        synced_at=now,
                    )
                )
                stats["attachments"] += 1

        session.commit()

    src.close()
    app.close()

    elapsed = time.time() - start

    if verbose and stats["messages"] > 0:
        msg_count = stats["messages"]
        att_count = stats["attachments"]
        print(f"Incremental sync: {msg_count} messages, {att_count} attachments in {elapsed:.2f}s")

    return {**stats, "elapsed": elapsed}
