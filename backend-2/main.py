import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import config
from db.sync import sync_all
from dependencies import get_app_db, get_embedding_db
from routers import actions, attachments, chats, contacts, eod, search, sync
from workers import start_scheduler, stop_scheduler

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan handler for startup and shutdown."""
    # Startup
    logger.info("Starting PRM Backend 2...")

    # Sync from chat.db to prm.db on startup
    logger.info("Syncing from chat.db...")
    try:
        stats = sync_all(config.CHAT_DB_PATH, config.PRM_DB_PATH, verbose=True)
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
