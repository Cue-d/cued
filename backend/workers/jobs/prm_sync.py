"""PRM sync job - incrementally syncs new messages from chat.db to prm.db."""

import logging
import os

from db.sync import sync_incremental

logger = logging.getLogger(__name__)

CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")


def run_prm_sync() -> None:
    """Incrementally sync new messages from chat.db to prm.db.

    Uses sync_incremental which only fetches messages newer than our
    highest synced message ID. Much faster than full sync for background jobs.
    """
    try:
        stats = sync_incremental(CHAT_DB_PATH, PRM_DB_PATH, verbose=False)
        if stats["messages"] > 0:
            logger.info(
                f"[PRM_SYNC] Synced {stats['messages']} messages in {stats['elapsed']:.2f}s"
            )
    except Exception as e:
        logger.error(f"[PRM_SYNC] Sync failed: {e}")
        raise
