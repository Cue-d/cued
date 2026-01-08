"""Semantic search with sentence-transformers embeddings."""

import logging
import time
from contextlib import contextmanager

import numpy as np
from sqlmodel import Session, create_engine, text

logger = logging.getLogger(__name__)
_model = None


def get_model():
    """Lazy-load sentence-transformer model (~90MB on first use)."""
    global _model
    if _model is None:
        logger.info("Loading sentence-transformers model...")
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


class EmbeddingDb:
    """Embedding database wrapper for embeddings.db."""

    def __init__(self, path: str):
        self.engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        with self.engine.connect() as conn:
            conn.execute(text("PRAGMA journal_mode = WAL"))
            conn.execute(text("PRAGMA busy_timeout = 30000"))
            conn.commit()

    def init_schema(self) -> None:
        with self.engine.connect() as conn:
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS embedding_queue (
                    message_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
                    queued_at INTEGER NOT NULL, status TEXT DEFAULT 'pending'
                )
            """)
            )
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS message_embeddings (
                    message_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
                    embedding BLOB NOT NULL, model_version TEXT DEFAULT 'all-MiniLM-L6-v2',
                    created_at INTEGER NOT NULL
                )
            """)
            )
            conn.execute(
                text("CREATE INDEX IF NOT EXISTS idx_queue_status ON embedding_queue(status)")
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
        with self.session() as session:
            session.execute(
                text(
                    "INSERT OR REPLACE INTO message_embeddings "
                    "(message_id, chat_id, embedding, created_at) "
                    "VALUES (:m, :c, :e, :t)"
                ),
                {"m": message_id, "c": chat_id, "e": embedding, "t": int(time.time())},
            )
            session.commit()

    def mark_complete(self, message_id: int) -> None:
        with self.session() as session:
            session.execute(
                text("UPDATE embedding_queue SET status = 'completed' WHERE message_id = :m"),
                {"m": message_id},
            )
            session.commit()

    def get_all_embeddings(self) -> list[tuple[int, int, bytes]]:
        with self.session() as session:
            return [
                (r[0], r[1], r[2])
                for r in session.execute(
                    text("SELECT message_id, chat_id, embedding FROM message_embeddings")
                )
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
            total = session.execute(text("SELECT COUNT(*) FROM message_embeddings")).scalar() or 0
            return {"pending": pending, "completed": completed, "total_embeddings": total}


def semantic_search(embedding_db: EmbeddingDb, query: str, limit: int = 20) -> list[dict]:
    """Search using cosine similarity."""
    query_emb = get_model().encode(query, convert_to_numpy=True)
    results = []
    for msg_id, chat_id, blob in embedding_db.get_all_embeddings():
        emb = np.frombuffer(blob, dtype=np.float32)
        sim = float(np.dot(query_emb, emb) / (np.linalg.norm(query_emb) * np.linalg.norm(emb)))
        results.append({"message_id": msg_id, "chat_id": chat_id, "similarity": sim})
    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:limit]


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
