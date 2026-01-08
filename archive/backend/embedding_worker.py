"""
Embedding worker for semantic search.

Uses sentence-transformers to generate embeddings for messages.
The model is loaded lazily on first use (~90MB download).
"""

import logging

import core
import numpy as np

from sync_db import APP_DB_PATH

logger = logging.getLogger(__name__)

# Lazy-loaded model instance
_model = None


def get_model():
    """Get the sentence-transformer model (lazy load on first use)."""
    global _model
    if _model is None:
        logger.info("Loading sentence-transformers model (first use)...")
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("all-MiniLM-L6-v2")
        logger.info("Model loaded successfully")
    return _model


def process_embedding_queue(batch_size: int = 100) -> int:
    """Process pending messages in embedding queue.

    Args:
        batch_size: Number of messages to process at once

    Returns:
        Number of messages processed
    """
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()

    # Get pending messages from queue
    pending = db.get_pending_embeddings(batch_size)
    if not pending:
        return 0

    # Filter to messages with text
    texts = []
    valid_messages = []
    for msg in pending:
        if msg.text and len(msg.text.strip()) > 0:
            texts.append(msg.text)
            valid_messages.append(msg)

    if not texts:
        return 0

    # Generate embeddings
    model = get_model()
    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)

    # Store embeddings
    for i, msg in enumerate(valid_messages):
        embedding_blob = embeddings[i].astype(np.float32).tobytes()
        db.insert_embedding(msg.id, msg.chat_id, embedding_blob)
        db.mark_embedding_complete(msg.id)

    logger.debug(f"Processed {len(valid_messages)} embeddings")
    return len(valid_messages)


def encode_query(query: str) -> np.ndarray:
    """Encode a search query into an embedding vector.

    Args:
        query: The search query text

    Returns:
        NumPy array of shape (384,) representing the query embedding
    """
    model = get_model()
    return model.encode(query, convert_to_numpy=True)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Calculate cosine similarity between two vectors."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def semantic_search(query: str, limit: int = 20) -> list[dict]:
    """Perform semantic search using embeddings.

    Args:
        query: The search query
        limit: Maximum number of results

    Returns:
        List of dicts with message_id, chat_id, similarity
    """
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()

    # Encode query
    query_embedding = encode_query(query)

    # Get all embeddings from DB
    embeddings_data = db.get_all_embeddings()
    if not embeddings_data:
        return []

    # Calculate cosine similarities
    results = []
    for item in embeddings_data:
        embedding = np.frombuffer(bytes(item.embedding), dtype=np.float32)
        similarity = cosine_similarity(query_embedding, embedding)
        results.append(
            {
                "message_id": item.message_id,
                "chat_id": item.chat_id,
                "similarity": similarity,
            }
        )

    # Sort by similarity (descending) and return top results
    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:limit]


def queue_all_messages():
    """Queue all existing messages for embedding generation (one-time setup)."""
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    count = db.queue_all_messages_for_embedding()
    logger.info(f"Queued {count} messages for embedding")
    return count


def get_queue_stats() -> dict:
    """Get embedding queue statistics."""
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    pending, completed, total_embeddings = db.get_embedding_queue_stats()
    return {
        "pending": pending,
        "completed": completed,
        "total_embeddings": total_embeddings,
    }


if __name__ == "__main__":
    # CLI for manual testing
    import sys

    logging.basicConfig(level=logging.INFO)

    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == "queue":
            queue_all_messages()
        elif command == "process":
            batch = int(sys.argv[2]) if len(sys.argv) > 2 else 100
            processed = process_embedding_queue(batch)
            print(f"Processed {processed} messages")
        elif command == "stats":
            stats = get_queue_stats()
            print(
                f"Pending: {stats['pending']}, Completed: {stats['completed']}, "
                f"Total: {stats['total_embeddings']}"
            )
        elif command == "search":
            query = " ".join(sys.argv[2:])
            results = semantic_search(query)
            for r in results[:10]:
                print(f"  {r['message_id']}: {r['similarity']:.4f}")
        else:
            print(f"Unknown command: {command}")
            print("Usage: embedding_worker.py [queue|process|stats|search <query>]")
    else:
        print("Usage: embedding_worker.py [queue|process|stats|search <query>]")
