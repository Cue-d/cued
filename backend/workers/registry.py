"""Job registration with consistent error handling."""

import functools
import logging

from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)


def job_wrapper(job_name: str):
    """Decorator that wraps jobs with consistent error handling and logging.

    Each job catches its own errors so one failing job doesn't crash the scheduler.
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                logger.exception(f"[{job_name}] Job failed: {e}")

        return wrapper

    return decorator


def register_all_jobs(
    scheduler: BackgroundScheduler,
    chat_db,
    app_db,
    embedding_db=None,
) -> None:
    """Register all background jobs with the scheduler.

    Args:
        scheduler: APScheduler BackgroundScheduler instance
        chat_db: ChatDb instance for reading chat.db
        app_db: AppDb instance for prm.db access
        embedding_db: Optional EmbeddingDb for semantic search embeddings
    """
    from .jobs.contacts_sync import run_contacts_sync
    from .jobs.deletion_scan import run_deletion_scan
    from .jobs.embedding_batch import run_embedding_batch
    from .jobs.llm_cleanup import run_llm_cleanup
    from .jobs.llm_processor import run_llm_processor
    from .jobs.text_sync import run_text_sync
    from .jobs.unanswered_scan import run_unanswered_scan

    # Job 0: Text cache sync - every 30 seconds (incremental)
    scheduler.add_job(
        job_wrapper("text_sync")(lambda: run_text_sync(chat_db, app_db)),
        "interval",
        seconds=30,
        id="text_sync",
        name="text_sync",
        max_instances=1,
    )

    # Job 1: Unanswered message scanner - every 5 minutes
    scheduler.add_job(
        job_wrapper("unanswered_scan")(lambda: run_unanswered_scan(chat_db, app_db)),
        "interval",
        minutes=5,
        id="unanswered_scan",
        name="unanswered_scan",
        max_instances=1,
    )

    # Job 2: LLM queue processor - every 10 seconds (rate-limited internally)
    scheduler.add_job(
        job_wrapper("llm_processor")(lambda: run_llm_processor(chat_db, app_db)),
        "interval",
        seconds=10,
        id="llm_processor",
        name="llm_processor",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=None,
    )

    # Job 3: LLM queue cleanup - every 1 hour
    scheduler.add_job(
        job_wrapper("llm_cleanup")(lambda: run_llm_cleanup(app_db)),
        "interval",
        hours=1,
        id="llm_cleanup",
        name="llm_cleanup",
        max_instances=1,
    )

    # Job 4: Embedding batch processor - every 5 minutes
    if embedding_db is not None:
        scheduler.add_job(
            job_wrapper("embedding_batch")(lambda: run_embedding_batch(app_db, embedding_db)),
            "interval",
            minutes=5,
            id="embedding_batch",
            name="embedding_batch",
            max_instances=1,
        )
    else:
        logger.info("Embedding batch job skipped (no embedding_db provided)")

    # Job 5: Deletion scan - every 5 minutes
    scheduler.add_job(
        job_wrapper("deletion_scan")(lambda: run_deletion_scan(chat_db, app_db, embedding_db)),
        "interval",
        minutes=5,
        id="deletion_scan",
        name="deletion_scan",
        max_instances=1,
    )

    # Job 6: Contacts sync - every 5 minutes
    scheduler.add_job(
        job_wrapper("contacts_sync")(lambda: run_contacts_sync(app_db)),
        "interval",
        minutes=5,
        id="contacts_sync",
        name="contacts_sync",
        max_instances=1,
    )

    job_count = 7 if embedding_db else 6
    logger.info(f"Registered {job_count} background jobs")
