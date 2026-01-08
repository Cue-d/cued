import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db.sync import sync_text_cache_full
from deps import get_app_db, get_chat_db, get_embedding_db
from routers import actions, attachments, chats, contacts, eod, search, sync
from services.contacts_sync import sync_contacts_to_db
from services.macos.contacts import is_swift_contacts_available
from services.search.fts import FtsIndex
from services.search.semantic import queue_missing_messages
from workers import start_scheduler, stop_scheduler

logger = logging.getLogger(__name__)


def configure_worker_logging() -> None:
    """Configure logging for background workers based on environment variable.

    Set PRM_DEBUG_WORKERS=1 to enable debug logging for background jobs.
    Set PRM_DEBUG_API=1 to enable debug logging for API routes.
    """
    debug_workers = os.environ.get("PRM_DEBUG_WORKERS", "").lower() in ("1", "true", "yes")
    debug_api = os.environ.get("PRM_DEBUG_API", "").lower() in ("1", "true", "yes")

    if debug_workers or debug_api:
        # Configure root logger to show debug output
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )

        # Enable debug for worker-related modules
        worker_loggers = [
            "workers",
            "workers.scheduler",
            "workers.registry",
            "workers.jobs.llm_processor",
            "workers.jobs.unanswered_scan",
            "workers.jobs.llm_cleanup",
            "workers.jobs.embedding_batch",
            "workers.jobs.text_sync",
            "workers.jobs.deletion_scan",
            "services.actions",
            "services.actions.llm_client",
            "services.actions.message_filter",
            "services.actions.priority",
            "routers.actions",
        ]
        if debug_workers:
            for logger_name in worker_loggers:
                logging.getLogger(logger_name).setLevel(logging.DEBUG)
            logger.info("Worker debug logging ENABLED (PRM_DEBUG_WORKERS=1)")

        if debug_api:
            api_loggers = ["routers.actions", "routers.chats", "routers.search", "routers.sync"]
            for logger_name in api_loggers:
                logging.getLogger(logger_name).setLevel(logging.DEBUG)
            logger.info("API debug logging ENABLED (PRM_DEBUG_API=1)")
    else:
        # Default: only show warnings and errors from workers
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )


# Configure logging before anything else
configure_worker_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan handler for startup and shutdown."""
    # Startup
    logger.info("Starting PRM Backend...")

    # Initialize databases
    chat_db = get_chat_db()
    app_db = get_app_db()
    embedding_db = get_embedding_db()

    # Check if text cache needs initial population
    cache_count = app_db.get_cache_count()
    if cache_count == 0:
        logger.info("Text cache empty, performing full sync from chat.db...")
        try:
            stats = sync_text_cache_full(chat_db, app_db, verbose=True)
            cached = stats["cached_messages"]
            elapsed = stats["elapsed"]
            cache_count = cached  # Update for FTS/embedding init
            logger.info(f"Full sync complete: {cached} messages in {elapsed:.2f}s")
        except Exception as e:
            logger.error(f"Full sync failed: {e}")
    else:
        logger.info(f"Text cache has {cache_count} messages, skipping full sync")

    # Sync contacts on first startup (if never synced and CLI available)
    last_contacts_sync = app_db.get_contacts_last_sync()
    if last_contacts_sync is None:
        if is_swift_contacts_available():
            logger.info("First startup: syncing contacts from Apple Contacts...")
            try:
                result = sync_contacts_to_db(app_db)
                if result.success:
                    logger.info(
                        f"Contacts sync complete: {result.contacts_added} contacts "
                        f"in {result.total_time_seconds:.2f}s"
                    )
                else:
                    logger.warning(f"Contacts sync failed: {result.message}")
            except Exception as e:
                logger.error(f"Contacts sync failed: {e}")
        else:
            logger.info("Contacts CLI not available, skipping initial contacts sync")
    else:
        logger.info("Contacts already synced, skipping initial sync")

    # Ensure FTS5 index exists and is populated
    try:
        fts = FtsIndex(app_db.engine)
        fts_indexed = fts.ensure_index(cache_count)
        if fts_indexed > 0:
            logger.info(f"FTS5 index rebuilt with {fts_indexed} messages")
        else:
            logger.info("FTS5 index already up to date")
    except Exception as e:
        logger.error(f"FTS5 index initialization failed: {e}")

    # Queue any messages missing embeddings
    try:
        queued = queue_missing_messages(app_db, embedding_db)
        if queued > 0:
            logger.info(f"Queued {queued} messages for embedding")
        else:
            logger.info("All messages already queued for embedding")
    except Exception as e:
        logger.error(f"Embedding queue initialization failed: {e}")

    # Start background scheduler with all database instances
    start_scheduler(chat_db, app_db, embedding_db)

    yield

    # Shutdown
    logger.info("Shutting down PRM Backend...")
    stop_scheduler()


app = FastAPI(title="PRM Backend", lifespan=lifespan)

# CORS for browser dev mode
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(chats.router, prefix="/chats", tags=["chats"])
app.include_router(actions.router, prefix="/actions", tags=["actions"])
app.include_router(attachments.router, prefix="/attachments", tags=["attachments"])
app.include_router(search.router, prefix="/search", tags=["search"])
app.include_router(eod.router, prefix="/eod", tags=["eod"])
app.include_router(sync.router, prefix="/sync", tags=["sync"])
app.include_router(contacts.router, prefix="/contacts", tags=["contacts"])


@app.get("/health")
def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
