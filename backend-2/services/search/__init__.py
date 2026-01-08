"""Search package - FTS5, semantic search, and RRF fusion."""

from .models import SearchResult
from .fts import FtsIndex
from .semantic import EmbeddingDb, semantic_search, process_queue, queue_all_messages
from .fusion import reciprocal_rank_fusion, merge_results

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
