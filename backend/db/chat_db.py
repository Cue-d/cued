"""Read-only access to macOS chat.db (iMessage database)."""

import logging
import sqlite3
import threading

from services.attributed_body import extract_text_from_attributed_body

from .models import (
    ChatWithLastMessage,
    MessageWithSender,
)

logger = logging.getLogger(__name__)

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


class ChatDb:
    """Read-only wrapper for macOS chat.db.

    Thread-safe: Uses a lock to serialize database access since SQLite
    connections aren't safe for concurrent access even in read-only mode.
    """

    def __init__(self, path: str):
        # Open read-only to avoid conflicts with Messages.app
        self.path = path
        self._lock = threading.Lock()
        logger.debug(f"Initializing ChatDb connection to {path}")
        self.conn = sqlite3.connect(
            f"file:{path}?mode=ro",
            uri=True,
            check_same_thread=False,  # Allow multi-threaded access (protected by lock)
            timeout=30.0,  # 30 second timeout for locked db
        )
        self.conn.row_factory = sqlite3.Row
        logger.debug("ChatDb connection established")

    def close(self) -> None:
        """Close the database connection."""
        logger.debug("Closing ChatDb connection")
        with self._lock:
            self.conn.close()

    # =========================================================================
    # CHAT QUERIES
    # =========================================================================

    def get_all_chats(self) -> list[ChatWithLastMessage]:
        """Get all chats with last message preview, ordered by recency."""
        with self._lock:
            cursor = self.conn.execute("""
            WITH participant_counts AS (
                SELECT chat_id, COUNT(*) as cnt
                FROM chat_handle_join
                GROUP BY chat_id
            ),
            last_messages AS (
                SELECT
                    cmj.chat_id,
                    m.text,
                    m.attributedBody,
                    m.date,
                    ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) as rn
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            )
            SELECT
                c.ROWID as id,
                c.chat_identifier as identifier,
                c.display_name as name,
                COALESCE(pc.cnt, 0) > 1 as is_group,
                lm.text,
                lm.attributedBody,
                lm.date
            FROM chat c
            LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
            LEFT JOIN last_messages lm ON lm.chat_id = c.ROWID AND lm.rn = 1
            ORDER BY lm.date DESC NULLS LAST
        """)

            results = []
            for row in cursor:
                last_msg_text = get_message_text(row["text"], row["attributedBody"])
                results.append(
                    ChatWithLastMessage(
                        id=row["id"],
                        identifier=row["identifier"],
                        name=row["name"] or row["identifier"],
                        is_group=bool(row["is_group"]),
                        last_message_text=last_msg_text,
                        last_message_timestamp=apple_to_unix(row["date"]),
                    )
                )
            return results

    def get_chat(self, chat_id: int) -> ChatWithLastMessage | None:
        """Get a single chat by ID."""
        with self._lock:
            cursor = self.conn.execute(
                """
            WITH participant_counts AS (
                SELECT chat_id, COUNT(*) as cnt
                FROM chat_handle_join
                WHERE chat_id = ?
                GROUP BY chat_id
            )
            SELECT
                c.ROWID as id,
                c.chat_identifier as identifier,
                c.display_name as name,
                COALESCE(pc.cnt, 0) > 1 as is_group
            FROM chat c
            LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
            WHERE c.ROWID = ?
            """,
                (chat_id, chat_id),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return ChatWithLastMessage(
                id=row["id"],
                identifier=row["identifier"],
                name=row["name"] or row["identifier"],
                is_group=bool(row["is_group"]),
                last_message_text=None,
                last_message_timestamp=None,
            )

    # =========================================================================
    # MESSAGE QUERIES
    # =========================================================================

    def get_chat_messages(self, chat_id: int, limit: int = 100) -> list[MessageWithSender]:
        """Get messages for a chat with sender info."""
        with self._lock:
            cursor = self.conn.execute(
                """
            SELECT
                m.ROWID as id,
                cmj.chat_id,
                CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
                h.id as sender_identifier,
                m.text,
                m.attributedBody,
                m.date,
                m.is_from_me,
                m.is_read,
                m.date_read,
                m.cache_has_attachments
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE cmj.chat_id = ?
            ORDER BY m.date DESC
            LIMIT ?
            """,
                (chat_id, limit),
            )

            results = []
            for row in cursor:
                msg_text = get_message_text(row["text"], row["attributedBody"])
                results.append(
                    MessageWithSender(
                        id=row["id"],
                        chat_id=row["chat_id"],
                        sender_id=row["sender_id"],
                        sender_name=row["sender_identifier"],
                        text=msg_text,
                        timestamp=apple_to_unix(row["date"]) or 0,
                        is_from_me=bool(row["is_from_me"]),
                        is_read=bool(row["is_read"]),
                        read_at=apple_to_unix(row["date_read"]),
                        has_attachments=bool(row["cache_has_attachments"]),
                    )
                )
            return results

    def get_message(self, message_id: int) -> MessageWithSender | None:
        """Get a single message by ID."""
        with self._lock:
            cursor = self.conn.execute(
                """
            SELECT
                m.ROWID as id,
                cmj.chat_id,
                CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
                h.id as sender_identifier,
                m.text,
                m.attributedBody,
                m.date,
                m.is_from_me,
                m.is_read,
                m.date_read,
                m.cache_has_attachments
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID = ?
            """,
                (message_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            msg_text = get_message_text(row["text"], row["attributedBody"])
            return MessageWithSender(
                id=row["id"],
                chat_id=row["chat_id"],
                sender_id=row["sender_id"],
                sender_name=row["sender_identifier"],
                text=msg_text,
                timestamp=apple_to_unix(row["date"]) or 0,
                is_from_me=bool(row["is_from_me"]),
                is_read=bool(row["is_read"]),
                read_at=apple_to_unix(row["date_read"]),
                has_attachments=bool(row["cache_has_attachments"]),
            )

    # =========================================================================
    # PARTICIPANT QUERIES
    # =========================================================================

    def get_chat_participants(self, chat_id: int) -> list[dict]:
        """Get participants for a chat. Returns list of {id, identifier, service}."""
        with self._lock:
            cursor = self.conn.execute(
                """
                SELECT h.ROWID as id, h.id as identifier, h.service
                FROM handle h
                INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
                WHERE chj.chat_id = ?
                """,
                (chat_id,),
            )
            return [
                {"id": row["id"], "identifier": row["identifier"], "service": row["service"]}
                for row in cursor
            ]

    # =========================================================================
    # ATTACHMENT QUERIES
    # =========================================================================

    def get_message_attachments(self, message_id: int) -> list[dict]:
        """Get attachments for a message."""
        with self._lock:
            cursor = self.conn.execute(
                """
                SELECT
                    a.ROWID as id,
                    maj.message_id,
                    a.filename,
                    a.mime_type,
                    a.uti,
                    a.total_bytes as size,
                    a.is_outgoing,
                    a.created_date
                FROM attachment a
                INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                WHERE maj.message_id = ?
                """,
                (message_id,),
            )
            return [
                {
                    "id": row["id"],
                    "message_id": row["message_id"],
                    "filename": row["filename"],
                    "path": row["filename"],  # Use filename as path
                    "mime_type": row["mime_type"],
                    "uti": row["uti"],
                    "size": row["size"],
                    "is_outgoing": bool(row["is_outgoing"]),
                    "created_at": apple_to_unix(row["created_date"]),
                }
                for row in cursor
            ]

    # =========================================================================
    # SYNC SUPPORT QUERIES
    # =========================================================================

    def get_new_messages_since(self, last_rowid: int) -> list[dict]:
        """Get all messages with ROWID > last_rowid for incremental sync."""
        with self._lock:
            cursor = self.conn.execute(
                """
                SELECT
                    m.ROWID as rowid,
                    cmj.chat_id,
                    m.text,
                    m.attributedBody,
                    m.date
                FROM message m
                INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                WHERE m.ROWID > ?
                ORDER BY m.ROWID
                """,
                (last_rowid,),
            )
            return [
                {
                    "rowid": row["rowid"],
                    "chat_id": row["chat_id"],
                    "text": row["text"],
                    "attributedBody": row["attributedBody"],
                    "timestamp": apple_to_unix(row["date"]),
                }
                for row in cursor
            ]

    def get_all_message_rowids(self) -> set[int]:
        """Get all message ROWIDs for deletion detection."""
        with self._lock:
            cursor = self.conn.execute("""
                SELECT m.ROWID
                FROM message m
                INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            """)
            return {row[0] for row in cursor}

    def get_max_message_rowid(self) -> int:
        """Get the highest message ROWID."""
        with self._lock:
            cursor = self.conn.execute("SELECT MAX(ROWID) FROM message")
            result = cursor.fetchone()
            return result[0] or 0

    # =========================================================================
    # UNANSWERED MESSAGE DETECTION
    # =========================================================================

    def get_unanswered_chats(self, threshold_hours: int = 24) -> list[dict]:
        """
        Get chats with unanswered messages older than threshold.
        Returns raw data for the caller to filter against actions/queue.
        """
        import time

        now = int(time.time())
        threshold_secs = threshold_hours * 3600
        threshold_apple = (now - threshold_secs - APPLE_EPOCH_OFFSET) * 1_000_000_000

        with self._lock:
            cursor = self.conn.execute(
                """
            WITH latest_messages AS (
                SELECT
                    cmj.chat_id,
                    MAX(CASE WHEN m.is_from_me = 1 THEN m.date ELSE 0 END) as my_latest,
                    MAX(CASE WHEN m.is_from_me = 0 THEN m.date ELSE 0 END) as their_latest
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                GROUP BY cmj.chat_id
            ),
            their_last_msg AS (
                SELECT
                    cmj.chat_id,
                    m.ROWID as message_id,
                    m.handle_id as sender_id,
                    m.text,
                    m.attributedBody,
                    m.date,
                    ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) as rn
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                WHERE m.is_from_me = 0
            )
            SELECT
                tlm.message_id,
                tlm.chat_id,
                tlm.sender_id,
                tlm.text,
                tlm.attributedBody,
                tlm.date,
                c.display_name as chat_name,
                h.id as person_identifier
            FROM latest_messages lm
            JOIN their_last_msg tlm ON tlm.chat_id = lm.chat_id AND tlm.rn = 1
            LEFT JOIN chat c ON c.ROWID = lm.chat_id
            LEFT JOIN handle h ON h.ROWID = tlm.sender_id
            WHERE lm.their_latest > lm.my_latest
              AND lm.their_latest < ?
            ORDER BY tlm.date DESC
            """,
                (threshold_apple,),
            )

            results = []
            for row in cursor:
                msg_text = get_message_text(row["text"], row["attributedBody"])
                timestamp = apple_to_unix(row["date"]) or 0
                hours_since = (now - timestamp) // 3600 if timestamp else 0
                results.append(
                    {
                        "message_id": row["message_id"],
                        "chat_id": row["chat_id"],
                        "sender_id": row["sender_id"],
                        "text": msg_text,
                        "timestamp": timestamp,
                        "chat_name": row["chat_name"],
                        "person_name": row["person_identifier"],
                        "hours_since": hours_since,
                    }
                )
            return results
