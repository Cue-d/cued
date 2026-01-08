"""Periodic message sync job - syncs new messages from chat.db to prm.db."""

import logging
import os

from db.sync import sync_all

logger = logging.getLogger(__name__)

CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")


def run_message_sync() -> None:
    """Sync messages from chat.db to prm.db.

    This performs a full sync - INSERT OR REPLACE ensures idempotency.
    New messages get added, existing ones get updated if changed.
    """
    try:
        stats = sync_all(CHAT_DB_PATH, PRM_DB_PATH, verbose=False)
        if stats["messages"] > 0:
            logger.info(
                f"[MESSAGE_SYNC] Synced {stats['messages']} messages in {stats['elapsed']:.2f}s"
            )
    except Exception as e:
        logger.error(f"[MESSAGE_SYNC] Sync failed: {e}")
        raise
