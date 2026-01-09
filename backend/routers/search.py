"""Search router - unified FTS5 + semantic search via RRF."""

import logging

from fastapi import APIRouter, Query

from db.models import ChatWithLastMessage
from deps import get_app_db, get_chat_db, get_embedding_db
from services.contacts import ContactResolver, get_chat_display_name
from services.search import (
    FtsIndex,
    SearchResult,
    merge_results,
    process_queue,
    queue_all_messages,
    semantic_search,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_fts: FtsIndex | None = None


def get_fts() -> FtsIndex:
    global _fts
    if _fts is None:
        _fts = FtsIndex(get_app_db().engine)
        _fts.init()
    return _fts


def enrich_results_with_chat_names(results: list[SearchResult]) -> list[SearchResult]:
    """Enrich search results with chat display names.

    Resolves chat_id to a human-readable chat name using contact resolution.
    For 1:1 chats, uses the contact name. For groups, uses the group name or
    participant names.
    """
    if not results:
        return results

    chat_db = get_chat_db()
    resolver = ContactResolver(get_app_db())

    # Collect unique chat IDs
    chat_ids = {r.chat_id for r in results}

    # Build a map of chat_id -> display name
    chat_name_map: dict[int, str] = {}

    # Collect all handles for batch lookup
    all_handles: set[str] = set()
    chat_participants: dict[int, list[str]] = {}
    chat_objects: dict[int, ChatWithLastMessage] = {}

    for chat_id in chat_ids:
        chat = chat_db.get_chat(chat_id)
        if not chat:
            continue
        chat_objects[chat_id] = chat

        try:
            participants = chat_db.get_chat_participants(chat_id)
            handle_ids = [p["identifier"] for p in participants]
        except Exception as e:
            logger.warning(f"Failed to get participants for chat {chat_id}: {e}")
            handle_ids = []

        chat_participants[chat_id] = handle_ids
        all_handles.update(handle_ids)

    # Batch resolve all handles to contact names
    handle_to_name = resolver.resolve_handles(list(all_handles))

    # Build display names for each chat
    for chat_id, chat in chat_objects.items():
        handle_ids = chat_participants.get(chat_id, [])
        chat_name_map[chat_id] = get_chat_display_name(chat, handle_to_name, handle_ids)

    # Update results with chat names using model_copy for cleaner code
    return [r.model_copy(update={"chat_name": chat_name_map.get(r.chat_id)}) for r in results]


@router.get("/", response_model=list[SearchResult])
def search(
    query: str = Query(..., description="Search query"),
    chat_id: int | None = Query(None, description="Filter by chat ID"),
    limit: int = Query(50, description="Max results"),
):
    """Unified search: FTS5 + semantic via RRF fusion."""
    fetch_limit = min(limit * 3, 150)

    try:
        fts_results = get_fts().search(query, fetch_limit)
        if chat_id:
            fts_results = [r for r in fts_results if r.chat_id == chat_id]
    except Exception as e:
        logger.warning(f"FTS search failed: {e}")
        fts_results = []

    try:
        sem_results = semantic_search(get_embedding_db(), query, fetch_limit)
        if chat_id:
            sem_results = [r for r in sem_results if r["chat_id"] == chat_id]
    except Exception as e:
        logger.warning(f"Semantic search failed: {e}")
        sem_results = []

    results = merge_results(fts_results, sem_results, get_app_db().get_cached_text, limit)
    return enrich_results_with_chat_names(results)


@router.post("/rebuild")
def rebuild_index():
    """Rebuild FTS5 index."""
    count = get_fts().rebuild()
    return {"success": True, "messages_indexed": count}


@router.post("/embeddings/queue-all")
def queue_embeddings():
    """Queue all messages for embedding."""
    count = queue_all_messages(get_app_db(), get_embedding_db())
    return {"success": True, "messages_queued": count}


@router.post("/embeddings/process")
def process_embeddings(batch_size: int = Query(100)):
    """Process pending embeddings."""
    processed = process_queue(get_app_db(), get_embedding_db(), batch_size)
    return {"success": True, "processed": processed}


@router.get("/embeddings/stats")
def embedding_stats():
    """Get embedding queue stats."""
    return get_embedding_db().get_stats()
