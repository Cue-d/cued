"""App database (prm.db) access layer."""

from contextlib import contextmanager

from sqlmodel import Session, SQLModel, create_engine, text

from .models import Attachment, Chat, ChatWithLastMessage, Handle, MessageWithSender


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
            result = session.exec(
                text("""
                    SELECT id, identifier, name, is_group, synced_at
                    FROM chats
                    WHERE id = :chat_id
                """).bindparams(chat_id=chat_id)
            )
            row = result.fetchone()
            if row:
                return Chat(
                    id=row[0],
                    identifier=row[1],
                    name=row[2],
                    is_group=bool(row[3]),
                    synced_at=row[4],
                )
            return None

    def get_all_chats(self) -> list[ChatWithLastMessage]:
        """Get all chats with last message preview."""
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
            result = session.exec(
                text("""
                    SELECT
                        m.id, m.chat_id, m.sender_id, h.identifier,
                        m.text, m.timestamp, m.is_from_me, m.is_read,
                        m.read_at, m.has_attachments
                    FROM messages m
                    LEFT JOIN handles h ON h.id = m.sender_id
                    WHERE m.chat_id = :chat_id
                    ORDER BY m.timestamp DESC
                    LIMIT :limit
                """).bindparams(chat_id=chat_id, limit=limit)
            )
            return [
                MessageWithSender(
                    id=row[0],
                    chat_id=row[1],
                    sender_id=row[2],
                    sender_name=row[3],  # Now using identifier as sender_name
                    text=row[4],
                    timestamp=row[5],
                    is_from_me=bool(row[6]),
                    is_read=bool(row[7]),
                    read_at=row[8],
                    has_attachments=bool(row[9]),
                )
                for row in result
            ]

    def get_chat_participants(self, chat_id: int) -> list[Handle]:
        """Get participants for a chat."""
        with self.session() as session:
            result = session.exec(
                text("""
                    SELECT h.id, h.identifier, h.service
                    FROM handles h
                    INNER JOIN chat_participants cp ON cp.handle_id = h.id
                    WHERE cp.chat_id = :chat_id
                """).bindparams(chat_id=chat_id)
            )
            return [
                Handle(
                    id=row[0],
                    identifier=row[1],
                    service=row[2],
                )
                for row in result
            ]

    def get_message_attachments(self, message_id: int) -> list[Attachment]:
        """Get attachments for a message."""
        with self.session() as session:
            result = session.exec(
                text("""
                    SELECT id, message_id, filename, path, mime_type,
                           uti, size, is_outgoing, created_at, synced_at
                    FROM attachments
                    WHERE message_id = :message_id
                """).bindparams(message_id=message_id)
            )
            return [
                Attachment(
                    id=row[0],
                    message_id=row[1],
                    filename=row[2],
                    path=row[3],
                    mime_type=row[4],
                    uti=row[5],
                    size=row[6],
                    is_outgoing=bool(row[7]),
                    created_at=row[8],
                    synced_at=row[9],
                )
                for row in result
            ]

    def get_attachment(self, attachment_id: int) -> Attachment | None:
        """Get a single attachment by ID."""
        with self.session() as session:
            result = session.exec(
                text("""
                    SELECT id, message_id, filename, path, mime_type,
                           uti, size, is_outgoing, created_at, synced_at
                    FROM attachments
                    WHERE id = :attachment_id
                """).bindparams(attachment_id=attachment_id)
            )
            row = result.fetchone()
            if not row:
                return None
            return Attachment(
                id=row[0],
                message_id=row[1],
                filename=row[2],
                path=row[3],
                mime_type=row[4],
                uti=row[5],
                size=row[6],
                is_outgoing=bool(row[7]),
                created_at=row[8],
                synced_at=row[9],
            )

    def close(self) -> None:
        self.engine.dispose()

    # =========================================================================
    # MESSAGE TEXT HELPERS (used by search package)
    # =========================================================================

    def get_all_message_ids_with_text(self) -> list[tuple[int, int, str]]:
        """Get all messages with text for embedding. Returns (id, chat_id, text)."""
        with self.session() as session:
            result = session.exec(
                text("""
                    SELECT id, chat_id, text
                    FROM messages
                    WHERE text IS NOT NULL AND length(text) > 0
                """)
            )
            return [(row[0], row[1], row[2]) for row in result]

    def get_message_text(self, message_id: int) -> str | None:
        """Get text for a single message."""
        with self.session() as session:
            result = session.execute(
                text("SELECT text FROM messages WHERE id = :id"),
                {"id": message_id},
            )
            row = result.fetchone()
            return row[0] if row else None
