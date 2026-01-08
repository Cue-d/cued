"""Search package - FTS5, semantic search, and RRF fusion."""

from .fts import FtsIndex
from .fusion import merge_results, reciprocal_rank_fusion
from .models import SearchResult
from .semantic import EmbeddingDb, process_queue, queue_all_messages, semantic_search

__all__ = [
    "SearchResult",
    "FtsIndex",
    "EmbeddingDb",
    "semantic_search",
    "process_queue",
    "queue_all_messages",
    "reciprocal_rank_fusion",
    "merge_results",
]
