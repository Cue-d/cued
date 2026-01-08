"""LLM queue cleanup job.

Removes completed analysis entries older than 24 hours to prevent
the analysis queue table from growing unbounded.

Schedule: Every 1 hour
"""

import logging

logger = logging.getLogger(__name__)

# Hours after which completed analysis entries are deleted
CLEANUP_THRESHOLD_HOURS = 24


def run_llm_cleanup(app_db, hours_old: int = CLEANUP_THRESHOLD_HOURS) -> None:
    """Clear old completed analysis entries.

    Args:
        app_db: AppDb instance
        hours_old: Delete entries older than this many hours
    """
    cleared = app_db.clear_old_analysis(hours_old)

    if cleared > 0:
        logger.info(f"[llm_cleanup] Cleared {cleared} old analysis entries")
    else:
        logger.debug("[llm_cleanup] No old entries to clear")
