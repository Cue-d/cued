"""APScheduler setup and lifecycle management."""

import logging
import threading
import time

from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)

# Global scheduler instance
_scheduler: BackgroundScheduler | None = None

# Thread-safe rate limiter for LLM calls
_llm_last_call_time: float = 0.0
_llm_rate_lock = threading.Lock()
LLM_RATE_LIMIT_SECONDS = 2.0


def can_call_llm() -> bool:
    """Check if enough time has passed since the last LLM call.

    Returns True if we can make an LLM call, False if we should skip this cycle.
    """
    global _llm_last_call_time
    with _llm_rate_lock:
        now = time.time()
        if now - _llm_last_call_time >= LLM_RATE_LIMIT_SECONDS:
            return True
        return False


def mark_llm_called() -> None:
    """Mark that an LLM call was just made."""
    global _llm_last_call_time
    with _llm_rate_lock:
        _llm_last_call_time = time.time()


def start_scheduler(app_db, embedding_db=None) -> None:
    """Initialize and start the background scheduler.

    Args:
        app_db: AppDb instance for database access
        embedding_db: Optional EmbeddingDb instance for semantic search
    """
    global _scheduler

    if _scheduler is not None:
        logger.warning("Scheduler already running, skipping start")
        return

    _scheduler = BackgroundScheduler()

    # Import and register all jobs
    from .registry import register_all_jobs

    register_all_jobs(_scheduler, app_db, embedding_db)

    _scheduler.start()
    logger.info(
        "[STARTUP] Background scheduler started "
        "(unanswered: 5min, LLM: 10s, cleanup: 1h, embed: 5min)"
    )


def stop_scheduler() -> None:
    """Gracefully stop the background scheduler."""
    global _scheduler

    if _scheduler is None:
        logger.warning("Scheduler not running, skipping stop")
        return

    _scheduler.shutdown(wait=True)
    logger.info("Background scheduler stopped")
    _scheduler = None


def get_scheduler() -> BackgroundScheduler | None:
    """Get the current scheduler instance (for testing/inspection)."""
    return _scheduler
