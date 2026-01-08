"""Search router - unified FTS5 + semantic search via RRF."""

import logging
import os

from fastapi import APIRouter, Query

from db.prm_db import AppDb
from services.search import (
    EmbeddingDb,
    FtsIndex,
    SearchResult,
    merge_results,
    process_queue,
    queue_all_messages,
    semantic_search,
)

logger = logging.getLogger(__name__)
router = APIRouter()

PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")
EMBEDDING_DB_PATH = os.path.expanduser("~/.prm/embeddings.db")

_app_db: AppDb | None = None
_embedding_db: EmbeddingDb | None = None
_fts: FtsIndex | None = None


def get_app_db() -> AppDb:
    global _app_db
    if _app_db is None:
        _app_db = AppDb(PRM_DB_PATH)
    return _app_db


def get_embedding_db() -> EmbeddingDb:
    global _embedding_db
    if _embedding_db is None:
        _embedding_db = EmbeddingDb(EMBEDDING_DB_PATH)
        _embedding_db.init_schema()
    return _embedding_db


def get_fts() -> FtsIndex:
    global _fts
    if _fts is None:
        _fts = FtsIndex(get_app_db().engine)
        _fts.init()
    return _fts


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

    return merge_results(fts_results, sem_results, get_app_db().get_message_text, limit)


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
