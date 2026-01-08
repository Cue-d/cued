"""Shared dependencies - database singletons and common utilities.

All routers should import database getters from here to ensure single instances.
"""

import os

from db.chat_db import ChatDb
from db.prm_db import AppDb
from services.search.semantic import EmbeddingDb

# Database paths
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")
EMBEDDING_DB_PATH = os.path.expanduser("~/.prm/embeddings.db")

# Global database instances
_chat_db: ChatDb | None = None
_app_db: AppDb | None = None
_embedding_db: EmbeddingDb | None = None


def get_chat_db() -> ChatDb:
    """Get or create the ChatDb singleton (read-only chat.db access)."""
    global _chat_db
    if _chat_db is None:
        _chat_db = ChatDb(CHAT_DB_PATH)
    return _chat_db


def get_app_db() -> AppDb:
    """Get or create the AppDb singleton (prm.db for actions/cache)."""
    global _app_db
    if _app_db is None:
        _app_db = AppDb(PRM_DB_PATH)
        _app_db.init_schema()
    return _app_db


def get_embedding_db() -> EmbeddingDb:
    """Get or create the EmbeddingDb singleton."""
    global _embedding_db
    if _embedding_db is None:
        _embedding_db = EmbeddingDb(EMBEDDING_DB_PATH)
        _embedding_db.init_schema()
    return _embedding_db
