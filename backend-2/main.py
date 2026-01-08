import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db.prm_db import AppDb
from db.sync import sync_all
from routers import actions, attachments, chats, contacts, eod, search, sync
from services.search.semantic import EmbeddingDb
from workers import start_scheduler, stop_scheduler

logger = logging.getLogger(__name__)


def configure_worker_logging() -> None:
    """Configure logging for background workers based on environment variable.

    Set PRM_DEBUG_WORKERS=1 to enable debug logging for background jobs.
    """
    debug_workers = os.environ.get("PRM_DEBUG_WORKERS", "").lower() in ("1", "true", "yes")

    if debug_workers:
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
            "workers.jobs.message_sync",
            "services.actions",
            "services.actions.llm_client",
            "services.actions.message_filter",
            "services.actions.priority",
        ]
        for logger_name in worker_loggers:
            logging.getLogger(logger_name).setLevel(logging.DEBUG)

        logger.info("Worker debug logging ENABLED (PRM_DEBUG_WORKERS=1)")
    else:
        # Default: only show warnings and errors from workers
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )


# Configure logging before anything else
configure_worker_logging()

# Database paths
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
PRM_DB_PATH = os.path.expanduser("~/.prm/prm.db")
EMBEDDING_DB_PATH = os.path.expanduser("~/.prm/embeddings.db")

# Global database instances for workers
_app_db: AppDb | None = None
_embedding_db: EmbeddingDb | None = None


def get_app_db() -> AppDb:
    """Get or create the AppDb singleton."""
    global _app_db
    if _app_db is None:
        _app_db = AppDb(PRM_DB_PATH)
        _app_db.init_schema()
    return _app_db


def get_embedding_db() -> EmbeddingDb:
    """Get or create the EmbeddingDb singleton."""
    global _embedding_db
    if _embedding_db is None:
        _embedding_db = EmbeddingDb(EMBEDDING_DB_PATH)
        _embedding_db.init_schema()
    return _embedding_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan handler for startup and shutdown."""
    # Startup
    logger.info("Starting PRM Backend 2...")

    # Sync from chat.db to prm.db on startup
    logger.info("Syncing from chat.db...")
    try:
        stats = sync_all(CHAT_DB_PATH, PRM_DB_PATH, verbose=True)
        logger.info(f"Sync complete: {stats['messages']} messages in {stats['elapsed']:.2f}s")
    except Exception as e:
        logger.error(f"Sync failed: {e}")

    app_db = get_app_db()
    embedding_db = get_embedding_db()
    start_scheduler(app_db, embedding_db)

    yield

    # Shutdown
    logger.info("Shutting down PRM Backend 2...")
    stop_scheduler()


app = FastAPI(title="PRM Backend 2", lifespan=lifespan)

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
