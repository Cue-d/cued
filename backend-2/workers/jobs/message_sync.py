"""Periodic message sync job - syncs new messages from chat.db to prm.db."""

import logging

from config import config
from db.sync import sync_incremental

logger = logging.getLogger(__name__)


def run_message_sync() -> None:
    """Sync new messages from chat.db to prm.db.

    Uses incremental sync to only process messages newer than the last sync.
    Falls back to full sync if no prior sync exists.
    """
    try:
        stats = sync_incremental(config.CHAT_DB_PATH, config.PRM_DB_PATH, verbose=False)
        if stats["messages"] > 0:
            logger.info(
                f"[MESSAGE_SYNC] Synced {stats['messages']} messages in {stats['elapsed']:.2f}s"
            )
    except Exception as e:
        logger.error(f"[MESSAGE_SYNC] Sync failed: {e}")
        raise
