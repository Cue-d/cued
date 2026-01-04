import logging

import core
from fastapi import APIRouter

from schemas import SearchResultResponse
from sync_db import APP_DB_PATH

logger = logging.getLogger(__name__)
router = APIRouter()


def get_db():
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    return db


@router.get("/", response_model=list[SearchResultResponse])
def search_messages(query: str, chat_id: int | None = None, limit: int = 50):
    """Full-text search across messages."""
    db = get_db()
    try:
        results = db.search_messages(query, limit)
        # Filter by chat_id if provided
        if chat_id:
            results = [r for r in results if r.chat_id == chat_id]
        return [
            SearchResultResponse(
                message_id=r.message_id,
                chat_id=r.chat_id,
                text=r.text,
                timestamp=r.timestamp,
                sender_name=r.sender_name,
                chat_name=r.chat_name,
                rank=r.rank,
            )
            for r in results
        ]
    except Exception as e:
        logger.error(f"Search error: {e}")
        # FTS might not be populated yet
        return []


@router.post("/rebuild")
def rebuild_search_index():
    """Rebuild the FTS index from existing messages."""
    db = get_db()
    count = db.rebuild_fts_index()
    return {"success": True, "messages_indexed": count}


@router.get("/semantic", response_model=list[SearchResultResponse])
def semantic_search(query: str, limit: int = 20):
    """Semantic search using embeddings.

    Uses sentence-transformers to encode the query and find similar messages
    via cosine similarity.
    """
    try:
        from embedding_worker import semantic_search as do_semantic_search

        results = do_semantic_search(query, limit)

        # Fetch message details for each result
        db = get_db()
        response = []
        for r in results:
            text = db.get_message_text(r["message_id"])
            if text:
                # Get chat name
                chat = db.get_chat(r["chat_id"])
                chat_name = chat.name if chat else None

                response.append(
                    SearchResultResponse(
                        message_id=r["message_id"],
                        chat_id=r["chat_id"],
                        text=text,
                        timestamp=0,  # Not fetching for now
                        sender_name=None,
                        chat_name=chat_name,
                        rank=r["similarity"],
                    )
                )

        return response
    except ImportError:
        logger.warning("Embedding worker not available")
        return []
    except Exception as e:
        logger.error(f"Semantic search error: {e}")
        return []


@router.post("/embeddings/queue-all")
def queue_all_embeddings():
    """Queue all existing messages for embedding generation."""
    try:
        from embedding_worker import queue_all_messages

        count = queue_all_messages()
        return {"success": True, "messages_queued": count}
    except ImportError:
        return {"success": False, "error": "Embedding worker not available"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/embeddings/process")
def process_embeddings(batch_size: int = 100):
    """Process pending embedding queue."""
    try:
        from embedding_worker import process_embedding_queue

        processed = process_embedding_queue(batch_size)
        return {"success": True, "processed": processed}
    except ImportError:
        return {"success": False, "error": "Embedding worker not available"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/embeddings/stats")
def get_embedding_stats():
    """Get embedding queue statistics."""
    try:
        from embedding_worker import get_queue_stats

        return get_queue_stats()
    except ImportError:
        return {
            "pending": 0,
            "completed": 0,
            "total_embeddings": 0,
            "error": "Worker not available",
        }
    except Exception as e:
        return {
            "pending": 0,
            "completed": 0,
            "total_embeddings": 0,
            "error": str(e),
        }
