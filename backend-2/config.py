"""Centralized configuration for PRM backend."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    """Application configuration with sensible defaults."""

    # Database paths
    PRM_DB_PATH: str = os.path.expanduser("~/.prm/prm.db")
    CHAT_DB_PATH: str = os.path.expanduser("~/Library/Messages/chat.db")
    EMBEDDING_DB_PATH: str = os.path.expanduser("~/.prm/embeddings.db")

    # Cache directories
    THUMBNAIL_CACHE_DIR: str = os.path.expanduser("~/.prm/thumbnails")
    FAISS_INDEX_PATH: str = os.path.expanduser("~/.prm/faiss.index")

    # Sync settings
    SYNC_INTERVAL_SECONDS: int = 30
    UNANSWERED_THRESHOLD_HOURS: int = 24

    # LLM settings
    LLM_TIMEOUT_SECONDS: int = 30
    LLM_RATE_LIMIT_SECONDS: float = 2.0
    MAX_PARALLEL_LLM_CALLS: int = 5

    # Embedding settings
    EMBEDDING_BATCH_SIZE: int = 50
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_DIMENSION: int = 384

    # Search settings
    SEMANTIC_SEARCH_LIMIT: int = 20
    FTS_SEARCH_LIMIT: int = 50


# Global config instance
config = Config()
