"""Text cache sync job - incrementally syncs message text from chat.db.

Schedule: Every 30 seconds
"""

import logging

from db.sync import sync_text_cache

logger = logging.getLogger(__name__)


def run_text_sync(chat_db, app_db) -> None:
    """Incrementally sync message text from chat.db to text cache.

    Extracts text from new messages (including attributedBody) and caches
    it for FTS5 and embedding indexing.
    """
    try:
        stats = sync_text_cache(chat_db, app_db, verbose=False)
        if stats["new_messages"] > 0:
            logger.info(
                f"[text_sync] Cached {stats['new_messages']} messages in {stats['elapsed']:.2f}s"
            )
    except Exception as e:
        logger.error(f"[text_sync] Sync failed: {e}")
        raise
