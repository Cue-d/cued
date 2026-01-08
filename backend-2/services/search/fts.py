"""FTS5 full-text search with BM25 ranking."""

from sqlmodel import text

from .models import SearchResult


class FtsIndex:
    """FTS5 index operations for message search."""

    def __init__(self, engine):
        self.engine = engine

    def init(self) -> None:
        """Create FTS5 virtual table."""
        with self.engine.connect() as conn:
            conn.execute(
                text("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                        text, content='messages', content_rowid='id',
                        tokenize='porter unicode61'
                    )
                """)
            )
            conn.commit()

    def rebuild(self) -> int:
        """Rebuild FTS index. Returns count indexed."""
        with self.engine.connect() as conn:
            conn.execute(text("DROP TABLE IF EXISTS messages_fts"))
            conn.execute(
                text("""
                    CREATE VIRTUAL TABLE messages_fts USING fts5(
                        text, content='messages', content_rowid='id',
                        tokenize='porter unicode61'
                    )
                """)
            )
            conn.execute(
                text("""
                    INSERT INTO messages_fts(rowid, text)
                    SELECT id, text FROM messages WHERE text IS NOT NULL
                """)
            )
            conn.commit()
            return conn.execute(text("SELECT COUNT(*) FROM messages_fts")).scalar() or 0

    def search(self, query: str, limit: int = 50) -> list[SearchResult]:
        """Full-text search using FTS5 with BM25 ranking."""
        with self.engine.connect() as conn:
            result = conn.execute(
                text("""
                    SELECT m.id, m.chat_id, m.text, m.timestamp,
                           h.identifier, c.name, bm25(messages_fts)
                    FROM messages_fts
                    JOIN messages m ON m.id = messages_fts.rowid
                    LEFT JOIN chats c ON c.id = m.chat_id
                    LEFT JOIN handles h ON h.id = m.sender_id
                    WHERE messages_fts MATCH :query
                    ORDER BY bm25(messages_fts)
                    LIMIT :limit
                """).bindparams(query=query, limit=limit)
            )
            return [
                SearchResult(
                    message_id=r[0], chat_id=r[1], text=r[2] or "",
                    timestamp=r[3], sender_name=r[4], chat_name=r[5], rank=r[6]
                )
                for r in result
            ]
