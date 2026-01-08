"""App database (prm.db) access layer."""

import time
from contextlib import contextmanager
from datetime import datetime

from sqlmodel import Session, SQLModel, create_engine, func, select, text

from .models import (
    Action,
    ActionWithContext,
    Attachment,
    Chat,
    ChatParticipant,
    ChatWithLastMessage,
    Handle,
    LlmAnalysisQueue,
    Message,
    MessageWithSender,
    QueuedAnalysis,
    UnansweredChat,
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
            conn.execute(text("PRAGMA foreign_keys = ON"))
            conn.commit()

    def init_schema(self) -> None:
        SQLModel.metadata.create_all(self.engine)

    @contextmanager
    def session(self):
        with Session(self.engine) as session:
            yield session

    def get_chat(self, chat_id: int) -> Chat | None:
        """Get a single chat by ID."""
        with self.session() as session:
            return session.get(Chat, chat_id)

    def get_all_chats(self) -> list[ChatWithLastMessage]:
        """Get all chats with last message preview.

        NOTE: Uses raw SQL for the correlated subquery (last message per chat).
        SQLModel doesn't support this pattern natively.
        """
        with self.session() as session:
            result = session.exec(
                text("""
                    SELECT
                        c.id, c.identifier, c.name, c.is_group,
                        m.text, m.timestamp
                    FROM chats c
                    LEFT JOIN messages m ON m.id = (
                        SELECT id FROM messages
                        WHERE chat_id = c.id
                        ORDER BY timestamp DESC LIMIT 1
                    )
                    ORDER BY m.timestamp DESC NULLS LAST
                """)
            )
            return [
                ChatWithLastMessage(
                    id=row[0],
                    identifier=row[1],
                    name=row[2],
                    is_group=bool(row[3]),
                    last_message_text=row[4],
                    last_message_timestamp=row[5],
                )
                for row in result
            ]

    def get_chat_messages(self, chat_id: int, limit: int = 100) -> list[MessageWithSender]:
        """Get messages for a chat with sender info."""
        with self.session() as session:
            # Use ORM with explicit join for sender
            stmt = (
                select(Message, Handle.identifier)
                .outerjoin(Handle, Message.sender_id == Handle.id)
                .where(Message.chat_id == chat_id)
                .order_by(Message.timestamp.desc())
                .limit(limit)
            )
            results = session.exec(stmt).all()
            return [
                MessageWithSender(
                    id=msg.id,
                    chat_id=msg.chat_id,
                    sender_id=msg.sender_id,
                    sender_name=sender_identifier,
                    text=msg.text,
                    timestamp=msg.timestamp,
                    is_from_me=msg.is_from_me,
                    is_read=msg.is_read,
                    read_at=msg.read_at,
                    has_attachments=msg.has_attachments,
                )
                for msg, sender_identifier in results
            ]

    def get_chat_participants(self, chat_id: int) -> list[Handle]:
        """Get participants for a chat."""
        with self.session() as session:
            stmt = (
                select(Handle)
                .join(ChatParticipant, ChatParticipant.handle_id == Handle.id)
                .where(ChatParticipant.chat_id == chat_id)
            )
            return list(session.exec(stmt).all())

    def get_message_attachments(self, message_id: int) -> list[Attachment]:
        """Get attachments for a message."""
        with self.session() as session:
            stmt = select(Attachment).where(Attachment.message_id == message_id)
            return list(session.exec(stmt).all())

    def get_attachment(self, attachment_id: int) -> Attachment | None:
        """Get a single attachment by ID."""
        with self.session() as session:
            return session.get(Attachment, attachment_id)

    def close(self) -> None:
        self.engine.dispose()

    # =========================================================================
    # MESSAGE TEXT HELPERS (used by search package)
    # =========================================================================

    def get_all_message_ids_with_text(self) -> list[tuple[int, int, str]]:
        """Get all messages with text for embedding. Returns (id, chat_id, text)."""
        with self.session() as session:
            stmt = (
                select(Message.id, Message.chat_id, Message.text)
                .where(Message.text.isnot(None))
                .where(func.length(Message.text) > 0)
            )
            return [(row[0], row[1], row[2]) for row in session.exec(stmt).all()]

    def get_message_text(self, message_id: int) -> str | None:
        """Get text for a single message."""
        with self.session() as session:
            msg = session.get(Message, message_id)
            return msg.text if msg else None

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
            action = Action(
                type=action_type,
                status="pending",
                priority=priority,
                chat_id=chat_id,
                person_id=person_id,
                message_id=message_id,
                payload=payload,
                created_at=now,
                remind_at=remind_at,
            )
            session.add(action)
            session.commit()
            session.refresh(action)
            return action.id

    def get_pending_actions(self, limit: int = 50) -> list[ActionWithContext]:
        """Get pending actions with joined context, ordered by priority.

        NOTE: Uses raw SQL for the complex ordering and snoozed logic.
        """
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT a.id, a.type, a.status, a.priority, a.chat_id, a.person_id,
                           a.message_id, a.payload, a.created_at, a.remind_at,
                           a.snoozed_until, a.completed_at, a.discarded_at,
                           c.name as chat_name, h.identifier as person_name,
                           m.text as message_text, m.timestamp as message_timestamp
                    FROM actions a
                    LEFT JOIN chats c ON c.id = a.chat_id
                    LEFT JOIN handles h ON h.id = a.person_id
                    LEFT JOIN messages m ON m.id = a.message_id
                    WHERE a.status = 'pending'
                       OR (a.status = 'snoozed' AND a.snoozed_until <= :now)
                    ORDER BY
                        CASE WHEN a.status = 'snoozed' THEN 1 ELSE 0 END ASC,
                        a.priority DESC,
                        a.created_at ASC
                    LIMIT :limit
                """),
                {"now": self._now_timestamp(), "limit": limit},
            )
            return [self._row_to_action_with_context(row) for row in result]

    def get_action(self, action_id: int) -> ActionWithContext | None:
        """Get single action with context.

        NOTE: Uses raw SQL for the multi-table join with aliases.
        """
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT a.id, a.type, a.status, a.priority, a.chat_id, a.person_id,
                           a.message_id, a.payload, a.created_at, a.remind_at,
                           a.snoozed_until, a.completed_at, a.discarded_at,
                           c.name as chat_name, h.identifier as person_name,
                           m.text as message_text, m.timestamp as message_timestamp
                    FROM actions a
                    LEFT JOIN chats c ON c.id = a.chat_id
                    LEFT JOIN handles h ON h.id = a.person_id
                    LEFT JOIN messages m ON m.id = a.message_id
                    WHERE a.id = :id
                """),
                {"id": action_id},
            )
            row = result.fetchone()
            return self._row_to_action_with_context(row) if row else None

    def _row_to_action_with_context(self, row) -> ActionWithContext:
        """Convert a database row to ActionWithContext."""
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
            chat_name=row[13],
            person_name=row[14],
            message_text=row[15],
            message_timestamp=row[16],
        )

    def update_action_status(
        self, action_id: int, status: str, snoozed_until: int | None = None
    ) -> None:
        """Update action status with appropriate timestamps."""
        now = self._now_timestamp()
        with self.session() as session:
            action = session.get(Action, action_id)
            if action:
                action.status = status
                action.snoozed_until = snoozed_until
                action.completed_at = now if status == "completed" else None
                action.discarded_at = now if status == "discarded" else None
                session.add(action)
                session.commit()

    def delete_action(self, action_id: int) -> None:
        """Delete an action."""
        with self.session() as session:
            action = session.get(Action, action_id)
            if action:
                session.delete(action)
                session.commit()

    # =========================================================================
    # UNANSWERED MESSAGE DETECTION
    # =========================================================================

    def get_unanswered_chats(self, threshold_hours: int = 24) -> list[UnansweredChat]:
        """Get chats with unanswered messages older than threshold.

        NOTE: Uses raw SQL for the complex CTE with aggregation and NOT EXISTS clauses.
        This query is too complex to express cleanly with SQLModel.
        """
        now = self._now_timestamp()
        threshold_secs = threshold_hours * 3600
        skip_window_secs = 6 * 3600
        skip_cutoff = now - skip_window_secs

        with self.session() as session:
            result = session.execute(
                text("""
                    WITH latest_messages AS (
                        SELECT
                            chat_id,
                            MAX(CASE WHEN is_from_me = 1 THEN timestamp ELSE 0 END) as my_latest,
                            MAX(CASE WHEN is_from_me = 0 THEN timestamp ELSE 0 END) as their_latest
                        FROM messages
                        GROUP BY chat_id
                    )
                    SELECT
                        m.id as message_id,
                        m.chat_id,
                        m.sender_id,
                        m.text,
                        m.timestamp,
                        c.name as chat_name,
                        h.identifier as person_name,
                        (:now - m.timestamp) / 3600 as hours_since
                    FROM messages m
                    JOIN latest_messages lm
                        ON lm.chat_id = m.chat_id AND m.timestamp = lm.their_latest
                    LEFT JOIN chats c ON c.id = m.chat_id
                    LEFT JOIN handles h ON h.id = m.sender_id
                    WHERE lm.their_latest > lm.my_latest
                    AND lm.their_latest < (:now - :threshold)
                    AND NOT EXISTS (
                        SELECT 1 FROM actions
                        WHERE chat_id = m.chat_id
                        AND type = 'respond_to_message'
                        AND (status IN ('pending', 'snoozed')
                             OR (status = 'discarded' AND discarded_at > (:now - 86400)))
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM llm_analysis_queue
                        WHERE chat_id = m.chat_id
                        AND status = 'completed'
                        AND result = 'no_action'
                        AND completed_at > :skip_cutoff
                    )
                    ORDER BY m.timestamp DESC
                """),
                {
                    "now": now,
                    "threshold": threshold_secs,
                    "skip_cutoff": skip_cutoff,
                },
            )
            return [
                UnansweredChat(
                    message_id=row[0],
                    chat_id=row[1],
                    sender_id=row[2],
                    text=row[3],
                    timestamp=row[4],
                    chat_name=row[5],
                    person_name=row[6],
                    hours_since=row[7],
                )
                for row in result
            ]

    # =========================================================================
    # LLM ANALYSIS QUEUE
    # =========================================================================

    def queue_for_analysis(self, chat_id: int, priority: int = 50) -> None:
        """Queue a chat for LLM analysis."""
        now = self._now_timestamp()
        with self.session() as session:
            # Check if exists
            existing = session.get(LlmAnalysisQueue, chat_id)
            if existing:
                existing.status = "pending"
                existing.priority = priority
                existing.queued_at = now
                existing.started_at = None
                existing.completed_at = None
                existing.result = None
            else:
                queue_item = LlmAnalysisQueue(
                    chat_id=chat_id,
                    status="pending",
                    priority=priority,
                    queued_at=now,
                )
                session.add(queue_item)
            session.commit()

    def get_next_pending_analysis(self) -> QueuedAnalysis | None:
        """Get next pending analysis item.

        NOTE: Uses raw SQL for the multi-table join with ordering.
        """
        with self.session() as session:
            result = session.execute(
                text("""
                    SELECT q.chat_id, q.status, q.priority, q.queued_at,
                           q.started_at, q.completed_at, q.result,
                           c.name as chat_name, h.identifier as person_name
                    FROM llm_analysis_queue q
                    LEFT JOIN chats c ON c.id = q.chat_id
                    LEFT JOIN chat_participants cp ON cp.chat_id = q.chat_id
                    LEFT JOIN handles h ON h.id = cp.handle_id
                    WHERE q.status = 'pending'
                    ORDER BY q.priority DESC, q.queued_at ASC
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
                chat_name=row[7],
                person_name=row[8],
            )

    def mark_analysis_started(self, chat_id: int) -> None:
        """Mark analysis as started."""
        now = self._now_timestamp()
        with self.session() as session:
            item = session.get(LlmAnalysisQueue, chat_id)
            if item:
                item.status = "processing"
                item.started_at = now
                session.add(item)
                session.commit()

    def mark_analysis_complete(self, chat_id: int, result: str) -> None:
        """Mark analysis as complete with result."""
        now = self._now_timestamp()
        with self.session() as session:
            item = session.get(LlmAnalysisQueue, chat_id)
            if item:
                item.status = "completed"
                item.completed_at = now
                item.result = result
                session.add(item)
                session.commit()

    def mark_analysis_skipped(self, chat_id: int, reason: str) -> None:
        """Mark analysis as skipped with reason."""
        now = self._now_timestamp()
        result_str = f"skipped:{reason}"
        with self.session() as session:
            existing = session.get(LlmAnalysisQueue, chat_id)
            if existing:
                existing.status = "completed"
                existing.priority = 0
                existing.queued_at = now
                existing.started_at = None
                existing.completed_at = now
                existing.result = result_str
            else:
                item = LlmAnalysisQueue(
                    chat_id=chat_id,
                    status="completed",
                    priority=0,
                    queued_at=now,
                    completed_at=now,
                    result=result_str,
                )
                session.add(item)
            session.commit()

    def clear_old_analysis(self, hours_old: int = 24) -> int:
        """Clear completed analysis entries older than given hours."""
        cutoff = self._now_timestamp() - (hours_old * 3600)
        with self.session() as session:
            stmt = (
                select(LlmAnalysisQueue)
                .where(LlmAnalysisQueue.status == "completed")
                .where(LlmAnalysisQueue.completed_at < cutoff)
            )
            items = session.exec(stmt).all()
            count = len(items)
            for item in items:
                session.delete(item)
            session.commit()
            return count

    # =========================================================================
    # EOD DETECTION
    # =========================================================================

    def has_eod_action_today(self, person_id: int) -> bool:
        """Check if person already has EOD action today."""
        today_start = int(
            datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        )
        with self.session() as session:
            stmt = (
                select(func.count())
                .select_from(Action)
                .where(Action.person_id == person_id)
                .where(Action.type == "eod_contact")
                .where(Action.created_at >= today_start)
            )
            count = session.exec(stmt).one()
            return count > 0
