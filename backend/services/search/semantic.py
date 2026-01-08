"""Semantic search with sentence-transformers embeddings and sqlite-vec."""

import logging
import time
from contextlib import contextmanager

import numpy as np
import sqlite_vec
from sqlalchemy import event
from sqlmodel import Session, create_engine, text

logger = logging.getLogger(__name__)
_model = None

# Vector dimensions for all-MiniLM-L6-v2
EMBEDDING_DIM = 384


def _load_vec_extension(dbapi_conn, connection_record):
    """Load sqlite-vec extension on each new SQLite connection."""
    dbapi_conn.enable_load_extension(True)
    sqlite_vec.load(dbapi_conn)
    dbapi_conn.enable_load_extension(False)


def get_model():
    """Lazy-load sentence-transformer model (~90MB on first use)."""
    global _model
    if _model is None:
        logger.info("Loading sentence-transformers model...")
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


class EmbeddingDb:
    """Embedding database wrapper using sqlite-vec for vector search."""

    def __init__(self, path: str):
        self.engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        # Load sqlite-vec extension on each connection
        event.listen(self.engine, "connect", _load_vec_extension)
        with self.engine.connect() as conn:
            conn.execute(text("PRAGMA journal_mode = WAL"))
            conn.execute(text("PRAGMA busy_timeout = 30000"))
            conn.commit()

    def init_schema(self) -> None:
        with self.engine.connect() as conn:
            # Embedding queue (unchanged)
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS embedding_queue (
                    message_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
                    queued_at INTEGER NOT NULL, status TEXT DEFAULT 'pending'
                )
            """)
            )
            conn.execute(
                text("CREATE INDEX IF NOT EXISTS idx_queue_status ON embedding_queue(status)")
            )
            # Metadata table for embeddings
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS message_embeddings_meta (
                    message_id INTEGER PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    model_version TEXT DEFAULT 'all-MiniLM-L6-v2',
                    created_at INTEGER NOT NULL
                )
            """)
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_embeddings_chat "
                    "ON message_embeddings_meta(chat_id)"
                )
            )
            # vec0 virtual table for fast KNN search with cosine distance
            conn.execute(
                text(f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings_vec USING vec0(
                    message_id INTEGER PRIMARY KEY,
                    embedding float[{EMBEDDING_DIM}] distance_metric=cosine
                )
            """)
            )
            conn.commit()

    @contextmanager
    def session(self):
        with Session(self.engine) as session:
            yield session

    def queue_messages(self, messages: list[tuple[int, int]]) -> int:
        if not messages:
            return 0
        now = int(time.time())
        with self.session() as session:
            for msg_id, chat_id in messages:
                session.execute(
                    text(
                        "INSERT OR IGNORE INTO embedding_queue "
                        "(message_id, chat_id, queued_at, status) "
                        "VALUES (:m, :c, :t, 'pending')"
                    ),
                    {"m": msg_id, "c": chat_id, "t": now},
                )
            session.commit()
        return len(messages)

    def get_pending(self, limit: int = 100) -> list[tuple[int, int]]:
        with self.session() as session:
            result = session.execute(
                text(
                    "SELECT message_id, chat_id FROM embedding_queue "
                    "WHERE status = 'pending' LIMIT :l"
                ),
                {"l": limit},
            )
            return [(r[0], r[1]) for r in result]

    def insert_embedding(self, message_id: int, chat_id: int, embedding: bytes) -> None:
        """Insert embedding into both metadata and vec0 tables."""
        now = int(time.time())
        with self.session() as session:
            # Insert metadata
            session.execute(
                text(
                    "INSERT OR REPLACE INTO message_embeddings_meta "
                    "(message_id, chat_id, model_version, created_at) "
                    "VALUES (:m, :c, 'all-MiniLM-L6-v2', :t)"
                ),
                {"m": message_id, "c": chat_id, "t": now},
            )
            # Insert vector into vec0 (embedding is already float32 bytes)
            session.execute(
                text(
                    "INSERT OR REPLACE INTO message_embeddings_vec "
                    "(message_id, embedding) VALUES (:m, :e)"
                ),
                {"m": message_id, "e": embedding},
            )
            session.commit()

    def mark_complete(self, message_id: int) -> None:
        with self.session() as session:
            session.execute(
                text("UPDATE embedding_queue SET status = 'completed' WHERE message_id = :m"),
                {"m": message_id},
            )
            session.commit()

    def knn_search(self, query_embedding: bytes, limit: int = 20) -> list[dict]:
        """Perform KNN search using sqlite-vec vec0 table.

        Args:
            query_embedding: Query vector as float32 bytes (384 dimensions)
            limit: Maximum number of results to return

        Returns:
            List of dicts with message_id, chat_id, and similarity (1 - cosine distance)
        """
        with self.session() as session:
            # sqlite-vec KNN query with cosine distance
            result = session.execute(
                text("""
                SELECT v.message_id, m.chat_id, v.distance
                FROM message_embeddings_vec v
                JOIN message_embeddings_meta m ON m.message_id = v.message_id
                WHERE v.embedding MATCH :query AND k = :k
            """),
                {"query": query_embedding, "k": limit},
            )
            return [
                {
                    "message_id": row[0],
                    "chat_id": row[1],
                    "similarity": 1.0 - row[2],  # Convert cosine distance to similarity
                }
                for row in result
            ]

    def get_stats(self) -> dict:
        with self.session() as session:
            pending = (
                session.execute(
                    text("SELECT COUNT(*) FROM embedding_queue WHERE status = 'pending'")
                ).scalar()
                or 0
            )
            completed = (
                session.execute(
                    text("SELECT COUNT(*) FROM embedding_queue WHERE status = 'completed'")
                ).scalar()
                or 0
            )
            total = (
                session.execute(text("SELECT COUNT(*) FROM message_embeddings_meta")).scalar() or 0
            )
            return {"pending": pending, "completed": completed, "total_embeddings": total}

    def delete_embeddings(self, message_ids: list[int]) -> int:
        """Delete embeddings for given message IDs. Returns count deleted."""
        if not message_ids:
            return 0
        with self.session() as session:
            deleted = 0
            for batch_start in range(0, len(message_ids), 500):
                batch = message_ids[batch_start : batch_start + 500]
                # Use parameterized queries to avoid SQL injection
                placeholders = ",".join(":" + str(i) for i in range(len(batch)))
                params = {str(i): mid for i, mid in enumerate(batch)}
                # Delete from metadata table
                result = session.execute(
                    text(
                        f"DELETE FROM message_embeddings_meta WHERE message_id IN ({placeholders})"
                    ),
                    params,
                )
                deleted += result.rowcount
                # Delete from vec0 table
                session.execute(
                    text(
                        f"DELETE FROM message_embeddings_vec WHERE message_id IN ({placeholders})"
                    ),
                    params,
                )
                # Also delete from queue
                session.execute(
                    text(f"DELETE FROM embedding_queue WHERE message_id IN ({placeholders})"),
                    params,
                )
            session.commit()
            return deleted


def semantic_search(embedding_db: EmbeddingDb, query: str, limit: int = 20) -> list[dict]:
    """Search using sqlite-vec KNN with cosine similarity.

    Performance: O(log n) with vec0 index vs O(n) with previous BLOB scan.
    """
    # Encode query to embedding
    query_emb = get_model().encode(query, convert_to_numpy=True)
    query_bytes = query_emb.astype(np.float32).tobytes()

    # Use vec0 KNN search
    return embedding_db.knn_search(query_bytes, limit)


def process_queue(app_db, embedding_db: EmbeddingDb, batch_size: int = 100) -> int:
    """Process pending embeddings."""
    pending = embedding_db.get_pending(batch_size)
    if not pending:
        return 0

    texts, valid = [], []
    for msg_id, chat_id in pending:
        txt = app_db.get_message_text(msg_id)
        if txt and txt.strip():
            texts.append(txt)
            valid.append((msg_id, chat_id))

    if not texts:
        return 0

    embeddings = get_model().encode(texts, convert_to_numpy=True, show_progress_bar=False)
    for i, (msg_id, chat_id) in enumerate(valid):
        embedding_db.insert_embedding(msg_id, chat_id, embeddings[i].astype(np.float32).tobytes())
        embedding_db.mark_complete(msg_id)
    return len(valid)


def queue_all_messages(app_db, embedding_db: EmbeddingDb) -> int:
    """Queue all messages for embedding."""
    messages = app_db.get_all_message_ids_with_text()
    return embedding_db.queue_messages([(m[0], m[1]) for m in messages])


def queue_missing_messages(app_db, embedding_db: EmbeddingDb) -> int:
    """Queue only messages that don't have embeddings yet.

    More efficient than queue_all_messages for startup since it
    skips messages that are already embedded or queued.

    Returns:
        Number of messages queued
    """
    # Get all message IDs from cache
    all_messages = app_db.get_all_message_ids_with_text()
    if not all_messages:
        return 0

    # Get IDs already in embedding queue or with embeddings
    with embedding_db.session() as session:
        queued_ids = {
            row[0] for row in session.execute(text("SELECT message_id FROM embedding_queue"))
        }
        embedded_ids = {
            row[0] for row in session.execute(text("SELECT message_id FROM message_embeddings"))
        }

    existing_ids = queued_ids | embedded_ids

    # Filter to only missing messages
    missing = [(m[0], m[1]) for m in all_messages if m[0] not in existing_ids]

    if not missing:
        return 0

    return embedding_db.queue_messages(missing)
