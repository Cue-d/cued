"""App database (prm.db) access layer.

This database stores:
- message_text_cache: Extracted text from chat.db messages for FTS5/embeddings
- sync_state: Tracks sync progress (including contacts sync)
- actions: Action queue for swipeable cards
- llm_analysis_queue: Queue for LLM conversation analysis
- contacts: Synced contacts from Apple Contacts
- contact_handles: Phone/email handles linked to contacts

All message/chat data is read directly from chat.db via ChatDb.
"""

import time
from contextlib import contextmanager
from datetime import datetime

from sqlmodel import Session, create_engine, text

from utils.phone import get_phone_variants, normalize_phone

from .models import (
    ActionWithContext,
    QueuedAnalysis,
)


class AppDb:
    """App database wrapper for prm.db."""

    def __init__(self, path: str):
        self.path = path
        self.engine = create_engine(
            f"sqlite:///{path}",
            connect_args={"check_same_thread": False},
        )
        self._configure_sqlite()

    def _configure_sqlite(self) -> None:
        with self.engine.connect() as conn:
            conn.execute(text("PRAGMA journal_mode = WAL"))
            conn.execute(text("PRAGMA busy_timeout = 30000"))
            conn.execute(text("PRAGMA foreign_keys = OFF"))  # No FKs to chat.db
            conn.commit()

    def init_schema(self) -> None:
        """Initialize the database schema."""
        with self.engine.connect() as conn:
            # Message text cache for FTS5 and embeddings
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS message_text_cache (
                    message_id INTEGER PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    synced_at INTEGER NOT NULL
                )
            """)
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_text_cache_chat ON message_text_cache(chat_id)"
                )
            )

            # Sync state tracking
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS sync_state (
                    key TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                )
            """)
            )

            # Actions table
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS actions (
                    id INTEGER PRIMARY KEY,
                    type TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    priority INTEGER DEFAULT 50,
                    chat_id INTEGER,
                    person_id INTEGER,
                    message_id INTEGER,
                    payload TEXT,
                    created_at INTEGER,
                    remind_at INTEGER,
                    snoozed_until INTEGER,
                    completed_at INTEGER,
                    discarded_at INTEGER
                )
            """)
            )
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status)"))

            # LLM analysis queue
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS llm_analysis_queue (
                    chat_id INTEGER PRIMARY KEY,
                    status TEXT DEFAULT 'pending',
                    priority INTEGER DEFAULT 50,
                    queued_at INTEGER,
                    started_at INTEGER,
                    completed_at INTEGER,
                    result TEXT,
                    latest_message_ts INTEGER
                )
            """)
            )

            # Contacts table - stores contact info fetched from Apple Contacts
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS contacts (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    company TEXT,
                    notes TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    deleted_at INTEGER
                )
            """)
            )

            # Contact handles - maps phone/email to contact
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS contact_handles (
                    id INTEGER PRIMARY KEY,
                    contact_id INTEGER NOT NULL,
                    handle TEXT NOT NULL,
                    handle_type TEXT NOT NULL,
                    FOREIGN KEY (contact_id) REFERENCES contacts(id)
                )
            """)
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_contact_handles_handle "
                    "ON contact_handles(handle)"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_contact_handles_contact "
                    "ON contact_handles(contact_id)"
                )
            )

            # Migration: Add latest_message_ts column if table exists but column doesn't
            # (for existing databases created before this column was added)
            result = conn.execute(text("PRAGMA table_info(llm_analysis_queue)"))
            columns = {row[1] for row in result}
            if "latest_message_ts" not in columns:
                conn.execute(
                    text("ALTER TABLE llm_analysis_queue ADD COLUMN latest_message_ts INTEGER")
                )

            conn.commit()

    @contextmanager
    def session(self):
        with Session(self.engine) as session:
            yield session

    @contextmanager
    def transaction(self):
        """Context manager for explicit transactions.

        Usage:
            with db.transaction() as session:
                session.execute(...)
                session.execute(...)
            # Auto-commits on success, rolls back on exception
        """
        with Session(self.engine) as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    def close(self) -> None:
        self.engine.dispose()

    # =========================================================================
    # TEXT CACHE METHODS
    # =========================================================================

    def cache_message_text(self, message_id: int, chat_id: int, msg_text: str) -> None:
        """Cache extracted text for a message."""
        now = int(time.time())
        with self.session() as session:
            session.execute(
                text("""
                    INSERT OR REPLACE INTO message_text_cache (message_id, chat_id, text, synced_at)
                    VALUES (:message_id, :chat_id, :text, :synced_at)
                """),
                {"message_id": message_id, "chat_id": chat_id, "text": msg_text, "synced_at": now},
            )
            session.commit()

    def cache_message_texts_batch(
        self, messages: list[tuple[int, int, str]], synced_at: int | None = None
    ) -> None:
        """Cache extracted text for multiple messages efficiently."""
        if not messages:
            return
        now = synced_at or int(time.time())
        with self.session() as session:
            for message_id, chat_id, msg_text in messages:
                session.execute(
                    text("""
                        INSERT OR REPLACE INTO message_text_cache
                        (message_id, chat_id, text, synced_at)
                        VALUES (:message_id, :chat_id, :text, :synced_at)
                    """),
                    {
                        "message_id": message_id,
                        "chat_id": chat_id,
                        "text": msg_text,
                        "synced_at": now,
                    },
                )
            session.commit()

    def get_cached_text(self, message_id: int) -> str | None:
        """Get cached text for a single message."""
        with self.session() as session:
            result = session.execute(
                text("SELECT text FROM message_text_cache WHERE message_id = :id"),
                {"id": message_id},
            )
            row = result.fetchone()
            return row[0] if row else None

    def get_all_cached_message_ids(self) -> set[int]:
        """Get all cached message IDs."""
        with self.session() as session:
            result = session.execute(text("SELECT message_id FROM message_text_cache"))
            return {row[0] for row in result}

    def delete_cached_messages(self, message_ids: list[int]) -> int:
        """Delete cached messages by IDs. Returns count deleted."""
        if not message_ids:
            return 0
        with self.session() as session:
            # Batch delete with proper parameterized queries
            deleted = 0
            for batch_start in range(0, len(message_ids), 500):
                batch = message_ids[batch_start : batch_start + 500]
                placeholders = ",".join(":" + str(i) for i in range(len(batch)))
                params = {str(i): mid for i, mid in enumerate(batch)}
                result = session.execute(
                    text(f"DELETE FROM message_text_cache WHERE message_id IN ({placeholders})"),
                    params,
                )
                deleted += result.rowcount
            session.commit()
            return deleted

    def get_all_message_ids_with_text(self) -> list[tuple[int, int, str]]:
        """Get all cached messages for embedding. Returns (message_id, chat_id, text)."""
        with self.session() as session:
            result = session.execute(
                text("SELECT message_id, chat_id, text FROM message_text_cache")
            )
            return [(row[0], row[1], row[2]) for row in result]

    def get_message_text(self, message_id: int) -> str | None:
        """Get cached text for a single message (alias for get_cached_text)."""
        return self.get_cached_text(message_id)

    # =========================================================================
    # SYNC STATE METHODS
    # =========================================================================

    def get_last_synced_rowid(self) -> int:
        """Get the last synced message ROWID."""
        with self.session() as session:
            result = session.execute(
                text("SELECT value FROM sync_state WHERE key = 'last_message_rowid'")
            )
            row = result.fetchone()
            return row[0] if row else 0

    def set_last_synced_rowid(self, rowid: int) -> None:
        """Set the last synced message ROWID."""
        with self.session() as session:
            session.execute(
                text("""
                    INSERT OR REPLACE INTO sync_state (key, value)
                    VALUES ('last_message_rowid', :rowid)
                """),
                {"rowid": rowid},
            )
            session.commit()

    def get_cache_count(self) -> int:
        """Get count of cached messages."""
        with self.session() as session:
            result = session.execute(text("SELECT COUNT(*) FROM message_text_cache"))
            return result.scalar() or 0

    # =========================================================================
    # ACTIONS CRUD
    # =========================================================================

    def _now_timestamp(self) -> int:
        """Get current Unix timestamp."""
        return int(time.time())

    def create_action(
        self,
        action_type: str,
        priority: int = 50,
        chat_id: int | None = None,
        person_id: int | None = None,
        message_id: int | None = None,
        payload: str | None = None,
        remind_at: int | None = None,
    ) -> int:
        """Create a new action. Returns the action ID."""
        now = self._now_timestamp()
        with self.session() as session:
            result = session.execute(
                text("""
                    INSERT INTO actions (type, status, priority, chat_id, person_id,
                                         message_id, payload, created_at, remind_at)
                    VALUES (:type, 'pending', :priority, :chat_id, :person_id,
                            :message_id, :payload, :created_at, :remind_at)
                """),
                {
                    "type": action_type,
                    "priority": priority,
                    "chat_id": chat_id,
                    "person_id": person_id,
                    "message_id": message_id,
                    "payload": payload,
                    "created_at": now,
                    "remind_at": remind_at,
                },
            )
            session.commit()
            return result.lastrowid

    def get_pending_actions(self) -> list[ActionWithContext]:
        """Get pending actions (context must be joined from ChatDb by caller)."""
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT id, type, status, priority, chat_id, person_id,
                           message_id, payload, created_at, remind_at,
                           snoozed_until, completed_at, discarded_at
                    FROM actions
                    WHERE status = 'pending'
                       OR (status = 'snoozed' AND snoozed_until <= :now)
                    ORDER BY
                        CASE WHEN status = 'snoozed' THEN 1 ELSE 0 END ASC,
                        priority DESC,
                        created_at ASC
                """),
                {"now": self._now_timestamp()},
            )
            return [
                ActionWithContext(
                    id=row[0],
                    type=row[1],
                    status=row[2],
                    priority=row[3],
                    chat_id=row[4],
                    person_id=row[5],
                    message_id=row[6],
                    payload=row[7],
                    created_at=row[8],
                    remind_at=row[9],
                    snoozed_until=row[10],
                    completed_at=row[11],
                    discarded_at=row[12],
                    # Context fields will be populated by caller from ChatDb
                    chat_name=None,
                    person_name=None,
                    message_text=None,
                    message_timestamp=None,
                )
                for row in result
            ]

    def get_action(self, action_id: int) -> ActionWithContext | None:
        """Get single action (context must be joined from ChatDb by caller)."""
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT id, type, status, priority, chat_id, person_id,
                           message_id, payload, created_at, remind_at,
                           snoozed_until, completed_at, discarded_at
                    FROM actions
                    WHERE id = :id
                """),
                {"id": action_id},
            )
            row = result.fetchone()
            if not row:
                return None
            return ActionWithContext(
                id=row[0],
                type=row[1],
                status=row[2],
                priority=row[3],
                chat_id=row[4],
                person_id=row[5],
                message_id=row[6],
                payload=row[7],
                created_at=row[8],
                remind_at=row[9],
                snoozed_until=row[10],
                completed_at=row[11],
                discarded_at=row[12],
                chat_name=None,
                person_name=None,
                message_text=None,
                message_timestamp=None,
            )

    def update_action_status(
        self, action_id: int, status: str, snoozed_until: int | None = None
    ) -> None:
        """Update action status with appropriate timestamps."""
        now = self._now_timestamp()
        completed_at = now if status == "completed" else None
        discarded_at = now if status == "discarded" else None

        with self.session() as session:
            session.execute(
                text("""
                    UPDATE actions
                    SET status = :status, snoozed_until = :snoozed_until,
                        completed_at = :completed_at, discarded_at = :discarded_at
                    WHERE id = :id
                """),
                {
                    "id": action_id,
                    "status": status,
                    "snoozed_until": snoozed_until,
                    "completed_at": completed_at,
                    "discarded_at": discarded_at,
                },
            )
            session.commit()

    def delete_action(self, action_id: int) -> None:
        """Delete an action."""
        with self.session() as session:
            session.execute(text("DELETE FROM actions WHERE id = :id"), {"id": action_id})
            session.commit()

    def has_pending_action_for_chat(self, chat_id: int, action_type: str) -> bool:
        """Check if chat already has a pending action of given type."""
        now = self._now_timestamp()
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM actions
                    WHERE chat_id = :chat_id
                      AND type = :type
                      AND (status IN ('pending', 'snoozed')
                           OR (status = 'discarded' AND discarded_at > :cutoff))
                    LIMIT 1
                """),
                {"chat_id": chat_id, "type": action_type, "cutoff": now - 86400},
            )
            return result.fetchone() is not None

    # =========================================================================
    # LLM ANALYSIS QUEUE
    # =========================================================================

    def queue_for_analysis(
        self, chat_id: int, priority: int = 50, latest_message_ts: int | None = None
    ) -> None:
        """Queue a chat for LLM analysis.

        Args:
            chat_id: The chat to queue
            priority: Priority score (0-100, higher = more important)
            latest_message_ts: Unix timestamp of the latest message (for ordering)
        """
        now = self._now_timestamp()
        with self.session() as session:
            session.execute(
                text("""
                    INSERT OR REPLACE INTO llm_analysis_queue
                    (chat_id, status, priority, queued_at, started_at, completed_at, result,
                     latest_message_ts)
                    VALUES (:chat_id, 'pending', :priority, :now, NULL, NULL, NULL,
                            :latest_message_ts)
                """),
                {
                    "chat_id": chat_id,
                    "priority": priority,
                    "now": now,
                    "latest_message_ts": latest_message_ts,
                },
            )
            session.commit()

    def get_next_pending_analysis(self) -> QueuedAnalysis | None:
        """Get next pending analysis item.

        Orders by most recent message first (latest_message_ts DESC),
        then by priority for messages from the same time period.
        """
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT chat_id, status, priority, queued_at,
                           started_at, completed_at, result, latest_message_ts
                    FROM llm_analysis_queue
                    WHERE status = 'pending'
                    ORDER BY latest_message_ts DESC, priority DESC, queued_at ASC
                    LIMIT 1
                """)
            )
            row = result.fetchone()
            if not row:
                return None
            return QueuedAnalysis(
                chat_id=row[0],
                status=row[1],
                priority=row[2],
                queued_at=row[3],
                started_at=row[4],
                completed_at=row[5],
                result=row[6],
                chat_name=None,  # Must be populated from ChatDb
                person_name=None,
            )

    def mark_analysis_started(self, chat_id: int) -> None:
        """Mark analysis as started."""
        now = self._now_timestamp()
        with self.session() as session:
            session.execute(
                text("""
                    UPDATE llm_analysis_queue
                    SET status = 'processing', started_at = :now
                    WHERE chat_id = :chat_id
                """),
                {"now": now, "chat_id": chat_id},
            )
            session.commit()

    def mark_analysis_complete(self, chat_id: int, result: str) -> None:
        """Mark analysis as complete with result."""
        now = self._now_timestamp()
        with self.session() as session:
            session.execute(
                text("""
                    UPDATE llm_analysis_queue
                    SET status = 'completed', completed_at = :now, result = :result
                    WHERE chat_id = :chat_id
                """),
                {"now": now, "result": result, "chat_id": chat_id},
            )
            session.commit()

    def mark_analysis_skipped(self, chat_id: int, reason: str) -> None:
        """Mark analysis as skipped with reason."""
        now = self._now_timestamp()
        result = f"skipped:{reason}"
        with self.session() as session:
            session.execute(
                text("""
                    INSERT OR REPLACE INTO llm_analysis_queue
                    (chat_id, status, priority, queued_at, started_at, completed_at, result)
                    VALUES (:chat_id, 'completed', 0, :now, NULL, :now, :result)
                """),
                {"chat_id": chat_id, "now": now, "result": result},
            )
            session.commit()

    def was_recently_skipped(self, chat_id: int, hours: int = 6) -> bool:
        """Check if chat was recently skipped (within given hours)."""
        cutoff = self._now_timestamp() - (hours * 3600)
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM llm_analysis_queue
                    WHERE chat_id = :chat_id
                      AND status = 'completed'
                      AND result = 'no_action'
                      AND completed_at > :cutoff
                    LIMIT 1
                """),
                {"chat_id": chat_id, "cutoff": cutoff},
            )
            return result.fetchone() is not None

    def clear_old_analysis(self, hours_old: int = 24) -> int:
        """Clear completed analysis entries older than given hours."""
        cutoff = self._now_timestamp() - (hours_old * 3600)
        with self.session() as session:
            result = session.execute(
                text("""
                    DELETE FROM llm_analysis_queue
                    WHERE status = 'completed' AND completed_at < :cutoff
                """),
                {"cutoff": cutoff},
            )
            session.commit()
            return result.rowcount

    # =========================================================================
    # EOD DETECTION
    # =========================================================================

    def has_eod_action_today(self, person_id: int) -> bool:
        """Check if person already has EOD action today."""
        today_start = int(
            datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        )
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT COUNT(*) FROM actions
                    WHERE person_id = :person_id
                    AND type = 'eod_contact'
                    AND created_at >= :today_start
                """),
                {"person_id": person_id, "today_start": today_start},
            )
            return result.scalar() > 0

    # =========================================================================
    # CONTACTS CRUD
    # =========================================================================

    def get_contacts_last_sync(self) -> int | None:
        """Get the last contacts sync timestamp."""
        with self.session() as session:
            result = session.execute(
                text("SELECT value FROM sync_state WHERE key = 'contacts_last_sync_at'")
            )
            row = result.fetchone()
            return int(row[0]) if row else None

    def set_contacts_last_sync(self, timestamp: int) -> None:
        """Set the last contacts sync timestamp."""
        with self.session() as session:
            session.execute(
                text("""
                    INSERT OR REPLACE INTO sync_state (key, value)
                    VALUES ('contacts_last_sync_at', :value)
                """),
                {"value": timestamp},
            )
            session.commit()

    def get_contact_count(self) -> dict:
        """Get contact counts."""
        with self.session() as session:
            active = (
                session.execute(
                    text("SELECT COUNT(*) FROM contacts WHERE deleted_at IS NULL")
                ).scalar()
                or 0
            )
            deleted = (
                session.execute(
                    text("SELECT COUNT(*) FROM contacts WHERE deleted_at IS NOT NULL")
                ).scalar()
                or 0
            )
            return {"active": active, "deleted": deleted, "total": active + deleted}

    def get_handle_count(self) -> int:
        """Get total handle count."""
        with self.session() as session:
            return session.execute(text("SELECT COUNT(*) FROM contact_handles")).scalar() or 0

    def clear_all_contacts_in_transaction(self, session) -> None:
        """Clear all contacts and handles within an existing transaction."""
        session.execute(text("DELETE FROM contact_handles"))
        session.execute(text("DELETE FROM contacts"))

    def insert_contact_in_transaction(
        self,
        session,
        name: str,
        phones: list[str],
        emails: list[str],
        company: str | None = None,
        notes: str | None = None,
    ) -> int:
        """Insert a new contact within an existing transaction. Returns contact ID."""
        now = self._now_timestamp()

        result = session.execute(
            text("""
                INSERT INTO contacts (name, company, notes, created_at, updated_at)
                VALUES (:name, :company, :notes, :created_at, :updated_at)
            """),
            {
                "name": name,
                "company": company,
                "notes": notes,
                "created_at": now,
                "updated_at": now,
            },
        )
        contact_id = result.lastrowid

        # Deduplicate and insert phone handles
        seen_phones = set()
        for phone in phones:
            normalized = normalize_phone(phone)
            if normalized and normalized not in seen_phones:
                seen_phones.add(normalized)
                session.execute(
                    text("""
                        INSERT INTO contact_handles (contact_id, handle, handle_type)
                        VALUES (:contact_id, :handle, 'phone')
                    """),
                    {"contact_id": contact_id, "handle": normalized},
                )

        # Deduplicate and insert email handles
        seen_emails = set()
        for email in emails:
            normalized = email.lower().strip()
            if normalized and normalized not in seen_emails:
                seen_emails.add(normalized)
                session.execute(
                    text("""
                        INSERT INTO contact_handles (contact_id, handle, handle_type)
                        VALUES (:contact_id, :handle, 'email')
                    """),
                    {"contact_id": contact_id, "handle": normalized},
                )

        return contact_id

    def get_names_for_handles(self, handles: list[str]) -> dict[str, str]:
        """Look up contact names for multiple handles. Returns {handle: name}.

        Handles phone number variants (e.g., +1xxx and xxx for US numbers).
        """
        if not handles:
            return {}

        # Build map of all variants to original handle
        variant_to_original: dict[str, str] = {}
        for h in handles:
            if "@" in h:
                variant_to_original[h.lower()] = h
            else:
                # For phones, generate all variants
                for variant in get_phone_variants(h):
                    variant_to_original[variant] = h

        all_variants = list(variant_to_original.keys())
        if not all_variants:
            return {}

        with self.session() as session:
            # Query in batches to avoid too many parameters
            name_map: dict[str, str] = {}
            batch_size = 100

            for i in range(0, len(all_variants), batch_size):
                batch = all_variants[i : i + batch_size]
                placeholders = ",".join(f":h{j}" for j in range(len(batch)))
                params = {f"h{j}": v for j, v in enumerate(batch)}

                result = session.execute(
                    text(f"""
                        SELECT ch.handle, c.name
                        FROM contacts c
                        JOIN contact_handles ch ON ch.contact_id = c.id
                        WHERE ch.handle IN ({placeholders}) AND c.deleted_at IS NULL
                    """),
                    params,
                )

                for row in result:
                    db_handle = row[0]
                    original_handle = variant_to_original.get(db_handle)
                    if original_handle and original_handle not in name_map:
                        name_map[original_handle] = row[1]

            return name_map
