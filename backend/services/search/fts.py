"""FTS5 full-text search with BM25 ranking.

Uses message_text_cache table instead of messages table.
The cache contains extracted text from chat.db messages.
"""

from sqlmodel import text

from .models import SearchResult


class FtsIndex:
    """FTS5 index operations for message search."""

    def __init__(self, engine):
        self.engine = engine

    def init(self) -> None:
        """Create FTS5 virtual table pointing to message_text_cache."""
        with self.engine.connect() as conn:
            conn.execute(
                text("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS message_text_fts USING fts5(
                        text,
                        content='message_text_cache',
                        content_rowid='message_id',
                        tokenize='porter unicode61'
                    )
                """)
            )
            conn.commit()

    def get_count(self) -> int:
        """Get count of indexed messages in FTS5."""
        with self.engine.connect() as conn:
            try:
                return conn.execute(text("SELECT COUNT(*) FROM message_text_fts")).scalar() or 0
            except Exception:
                return 0

    def ensure_index(self, cache_count: int) -> int:
        """Ensure FTS5 index exists and is populated. Returns count indexed.

        Rebuilds the index if:
        - FTS table doesn't exist or is corrupt
        - FTS is empty but cache has messages
        - FTS count differs significantly from cache count (>10% drift)

        Args:
            cache_count: Number of messages in message_text_cache

        Returns:
            Number of messages indexed (0 if no rebuild needed)
        """
        self.init()

        if cache_count == 0:
            return 0

        fts_count = self.get_count()

        # Rebuild if FTS is empty or significantly out of sync
        if fts_count == 0 or abs(fts_count - cache_count) > cache_count * 0.1:
            return self.rebuild()

        return 0

    def rebuild(self) -> int:
        """Rebuild FTS index from message_text_cache. Returns count indexed."""
        with self.engine.connect() as conn:
            conn.execute(text("DROP TABLE IF EXISTS message_text_fts"))
            conn.execute(
                text("""
                    CREATE VIRTUAL TABLE message_text_fts USING fts5(
                        text,
                        content='message_text_cache',
                        content_rowid='message_id',
                        tokenize='porter unicode61'
                    )
                """)
            )
            conn.execute(
                text("""
                    INSERT INTO message_text_fts(rowid, text)
                    SELECT message_id, text FROM message_text_cache
                """)
            )
            conn.commit()
            return conn.execute(text("SELECT COUNT(*) FROM message_text_fts")).scalar() or 0

    def search(self, query: str, limit: int = 50) -> list[SearchResult]:
        """
        Full-text search using FTS5 with BM25 ranking.

        Note: Since we no longer have chats/handles tables in prm.db,
        we return only message_id, chat_id, text, and rank.
        The caller must join with ChatDb for chat_name and sender_name.
        """
        with self.engine.connect() as conn:
            result = conn.execute(
                text("""
                    SELECT
                        c.message_id,
                        c.chat_id,
                        c.text,
                        c.synced_at,
                        bm25(message_text_fts) as rank
                    FROM message_text_fts
                    JOIN message_text_cache c ON c.message_id = message_text_fts.rowid
                    WHERE message_text_fts MATCH :query
                    ORDER BY bm25(message_text_fts)
                    LIMIT :limit
                """).bindparams(query=query, limit=limit)
            )
            return [
                SearchResult(
                    message_id=r[0],
                    chat_id=r[1],
                    text=r[2] or "",
                    timestamp=r[3],  # Using synced_at as timestamp placeholder
                    sender_name=None,  # Must be populated from ChatDb
                    chat_name=None,  # Must be populated from ChatDb
                    rank=r[4],
                )
                for r in result
            ]
