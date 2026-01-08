"""FastAPI dependency injection for shared resources.

This module provides centralized singleton instances for database connections
and services, eliminating the scattered module-level singletons in routers.

Usage in routers:
    from fastapi import Depends
    from dependencies import get_app_db, get_embedding_db

    @router.get("/")
    def list_items(db: AppDb = Depends(get_app_db)):
        return db.get_all_items()
"""

from functools import lru_cache

from config import config
from db.prm_db import AppDb
from services.search.semantic import EmbeddingDb


@lru_cache(maxsize=1)
def get_app_db() -> AppDb:
    """Get or create the AppDb singleton.

    Uses lru_cache to ensure only one instance is created across
    all router modules and background workers.
    """
    db = AppDb(config.PRM_DB_PATH)
    db.init_schema()
    return db


@lru_cache(maxsize=1)
def get_embedding_db() -> EmbeddingDb:
    """Get or create the EmbeddingDb singleton."""
    db = EmbeddingDb(config.EMBEDDING_DB_PATH)
    db.init_schema()
    return db


def reset_singletons() -> None:
    """Reset cached singletons (for testing)."""
    get_app_db.cache_clear()
    get_embedding_db.cache_clear()
