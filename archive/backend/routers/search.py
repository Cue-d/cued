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


def reciprocal_rank_fusion(
    fts_results: list[dict],
    semantic_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """
    Merge FTS and semantic results using Reciprocal Rank Fusion.

    RRF score = sum(1 / (k + rank)) for each ranker where the item appears.
    Items appearing in both result sets get boosted.

    Args:
        fts_results: List of message dicts ordered by FTS rank
        semantic_results: List of message dicts ordered by semantic rank
        k: RRF constant (default 60, higher = more weight to lower-ranked items)

    Returns:
        Merged list sorted by RRF score descending
    """
    scores: dict[int, dict] = {}

    # Process FTS results
    for rank, result in enumerate(fts_results, start=1):
        msg_id = result["message_id"]
        scores[msg_id] = {
            "score": 1.0 / (k + rank),
            "data": result,
        }

    # Process semantic results
    for rank, result in enumerate(semantic_results, start=1):
        msg_id = result["message_id"]
        semantic_score = 1.0 / (k + rank)

        if msg_id in scores:
            # Message in both: add semantic contribution
            scores[msg_id]["score"] += semantic_score
            # Prefer FTS data (has timestamp/sender_name)
        else:
            scores[msg_id] = {
                "score": semantic_score,
                "data": result,
            }

    # Sort by score descending
    return sorted(scores.values(), key=lambda x: x["score"], reverse=True)


def _fetch_fts_results(query: str, limit: int, chat_id: int | None) -> list[dict]:
    """Fetch FTS results as dicts."""
    try:
        db = get_db()
        results = db.search_messages(query, limit)
        out = []
        for r in results:
            if chat_id and r.chat_id != chat_id:
                continue
            out.append(
                {
                    "message_id": r.message_id,
                    "chat_id": r.chat_id,
                    "text": r.text,
                    "timestamp": r.timestamp,
                    "sender_name": r.sender_name,
                    "chat_name": r.chat_name,
                }
            )
        return out
    except Exception as e:
        logger.warning(f"FTS search failed: {e}")
        return []


def _fetch_semantic_results(query: str, limit: int, chat_id: int | None) -> list[dict]:
    """Fetch semantic results with full message details."""
    try:
        from embedding_worker import semantic_search as do_semantic_search

        results = do_semantic_search(query, limit)
        db = get_db()
        out = []

        for r in results:
            if chat_id and r["chat_id"] != chat_id:
                continue

            # Fetch full message details
            msg = db.get_message(r["message_id"])
            if msg:
                # Get sender name
                sender_name = None
                if msg.sender_id:
                    person = db.get_person(msg.sender_id)
                    sender_name = person.name if person else None

                # Get chat name
                chat = db.get_chat(r["chat_id"])
                chat_name = chat.name if chat else None

                out.append(
                    {
                        "message_id": r["message_id"],
                        "chat_id": r["chat_id"],
                        "text": msg.text or "",
                        "timestamp": msg.timestamp,
                        "sender_name": sender_name,
                        "chat_name": chat_name,
                    }
                )
        return out
    except ImportError:
        logger.warning("Embedding worker not available")
        return []
    except Exception as e:
        logger.warning(f"Semantic search failed: {e}")
        return []


@router.get("/", response_model=list[SearchResultResponse])
def search_messages(query: str, chat_id: int | None = None, limit: int = 50):
    """Unified search combining FTS and semantic results via Reciprocal Rank Fusion."""
    # Fetch more results than needed for better fusion quality
    fetch_limit = min(limit * 3, 150)

    # Fetch both result sets
    fts_results = _fetch_fts_results(query, fetch_limit, chat_id)
    semantic_results = _fetch_semantic_results(query, fetch_limit, chat_id)

    # If both are empty, return empty
    if not fts_results and not semantic_results:
        return []

    # Merge with RRF
    merged = reciprocal_rank_fusion(fts_results, semantic_results)

    # Normalize scores to 0-1 range for frontend display
    if merged:
        max_score = merged[0]["score"]
        for item in merged:
            item["normalized_score"] = item["score"] / max_score if max_score > 0 else 0

    # Convert to response objects
    return [
        SearchResultResponse(
            message_id=item["data"]["message_id"],
            chat_id=item["data"]["chat_id"],
            text=item["data"]["text"],
            timestamp=item["data"]["timestamp"],
            sender_name=item["data"].get("sender_name"),
            chat_name=item["data"].get("chat_name"),
            rank=item.get("normalized_score", 0),
        )
        for item in merged[:limit]
    ]


@router.post("/rebuild")
def rebuild_search_index():
    """Rebuild the FTS index from existing messages."""
    db = get_db()
    count = db.rebuild_fts_index()
    return {"success": True, "messages_indexed": count}


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
