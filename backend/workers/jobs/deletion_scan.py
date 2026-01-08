"""Deletion scan job - detects deleted messages and cleans up indexes.

Schedule: Every 5 minutes
"""

import logging

from db.sync import detect_deletions

logger = logging.getLogger(__name__)


def run_deletion_scan(chat_db, app_db, embedding_db=None) -> None:
    """Detect deleted messages in chat.db and clean up orphaned index entries.

    Compares cached message IDs with current chat.db message IDs and removes
    orphaned entries from the text cache and embeddings.
    """
    try:
        deleted = detect_deletions(chat_db, app_db, embedding_db, verbose=False)
        if deleted > 0:
            logger.info(f"[deletion_scan] Cleaned up {deleted} deleted messages")
    except Exception as e:
        logger.error(f"[deletion_scan] Scan failed: {e}")
        raise
