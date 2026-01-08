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
    app_db,
    embedding_db=None,
) -> None:
    """Register all background jobs with the scheduler.

    Args:
        scheduler: APScheduler BackgroundScheduler instance
        app_db: AppDb instance for database access
        embedding_db: Optional EmbeddingDb for semantic search embeddings
    """
    from .jobs.embedding_batch import run_embedding_batch
    from .jobs.llm_cleanup import run_llm_cleanup
    from .jobs.llm_processor import run_llm_processor
    from .jobs.unanswered_scan import run_unanswered_scan

    # Job 1: Unanswered message scanner - every 5 minutes
    scheduler.add_job(
        job_wrapper("unanswered_scan")(lambda: run_unanswered_scan(app_db)),
        "interval",
        minutes=5,
        id="unanswered_scan",
        max_instances=1,
    )

    # Job 2: LLM queue processor - every 10 seconds (rate-limited internally)
    scheduler.add_job(
        job_wrapper("llm_processor")(lambda: run_llm_processor(app_db)),
        "interval",
        seconds=10,
        id="llm_processor",
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
        max_instances=1,
    )

    # Job 4: Embedding batch processor - every 5 minutes
    if embedding_db is not None:
        scheduler.add_job(
            job_wrapper("embedding_batch")(lambda: run_embedding_batch(app_db, embedding_db)),
            "interval",
            minutes=5,
            id="embedding_batch",
            max_instances=1,
        )
    else:
        logger.info("Embedding batch job skipped (no embedding_db provided)")

    logger.info(f"Registered {4 if embedding_db else 3} background jobs")
