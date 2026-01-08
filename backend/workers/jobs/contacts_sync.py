"""Contacts sync job - periodically syncs contacts from Apple Contacts.

Schedule: Every 5 minutes
"""

import logging

from services.contacts_sync import sync_contacts_to_db
from services.macos.contacts import is_swift_contacts_available

logger = logging.getLogger(__name__)


def run_contacts_sync(app_db) -> None:
    """Sync contacts from Apple Contacts using Swift CLI.

    Uses the shared sync_contacts_to_db service for consistent behavior
    with the HTTP endpoint. Logs timing for performance monitoring.

    Note:
        This job does not raise exceptions - errors are logged and the job
        continues. This prevents APScheduler from marking the job as failed.
    """
    if not is_swift_contacts_available():
        logger.debug("[contacts_sync] Swift CLI not available, skipping")
        return

    result = sync_contacts_to_db(app_db)

    if result.success:
        if result.contacts_added > 0:
            logger.info(
                f"[contacts_sync] Synced {result.contacts_added} contacts "
                f"(fetch: {result.fetch_time_seconds:.3f}s, "
                f"db: {result.db_time_seconds:.3f}s, "
                f"total: {result.total_time_seconds:.3f}s)"
            )
        else:
            logger.info(f"[contacts_sync] {result.message}")
    elif "access denied" in result.message.lower():
        logger.warning(f"[contacts_sync] {result.message}")
    else:
        logger.error(f"[contacts_sync] {result.message}")
