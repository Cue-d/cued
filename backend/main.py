import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from threading import Lock, Thread

import core
from fastapi import FastAPI

from routers import chats
from sync_db import APP_DB_PATH, CHAT_DB_PATH, sync_all

logger = logging.getLogger(__name__)

# Global sync watcher instance (Rust background thread)
sync_watcher: core.SyncWatcher | None = None


def has_existing_data() -> bool:
    """Check if prm.db has existing data (skip initial sync screen)."""
    if not os.path.exists(APP_DB_PATH):
        return False
    try:
        db = core.AppDb(APP_DB_PATH)
        db.init_schema()
        chats = db.get_all_chats()  # Just check if any chats exist
        return len(chats) > 0
    except Exception:
        return False


@dataclass
class SyncStatus:
    """Thread-safe sync status tracker."""

    is_syncing: bool = False
    initial_sync_complete: bool = False
    last_sync_at: float | None = None
    last_sync_duration: float | None = None
    last_error: str | None = None
    _lock: Lock = field(default_factory=Lock)

    def start_sync(self):
        with self._lock:
            self.is_syncing = True
            self.last_error = None

    def end_sync(self, duration: float, error: str | None = None):
        with self._lock:
            self.is_syncing = False
            self.initial_sync_complete = True
            self.last_sync_at = time.time()
            self.last_sync_duration = duration
            self.last_error = error

    def should_sync(self) -> bool:
        """Check if a sync should run (not currently syncing)."""
        with self._lock:
            return not self.is_syncing

    def try_start_sync(self) -> bool:
        """Atomically check if we can sync and start it. Returns True if started."""
        with self._lock:
            if self.is_syncing:
                return False
            self.is_syncing = True
            self.last_error = None
            return True

    def mark_initial_sync_complete(self):
        """Mark initial sync as complete (for existing data case)."""
        with self._lock:
            self.initial_sync_complete = True

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "is_syncing": self.is_syncing,
                "initial_sync_complete": self.initial_sync_complete,
                "last_sync_at": self.last_sync_at,
                "last_sync_duration": self.last_sync_duration,
                "last_error": self.last_error,
            }


# Global sync status
sync_status = SyncStatus()


def run_sync(verbose: bool = False) -> None:
    """Run sync with status tracking."""
    sync_status.start_sync()
    start = time.time()
    error = None
    try:
        sync_all(verbose=verbose)
    except Exception as e:
        error = str(e)
        raise
    finally:
        sync_status.end_sync(time.time() - start, error)


def trigger_background_sync():
    """Trigger a sync in the background if enough time has passed."""
    if not sync_status.should_sync():
        return

    def _sync():
        try:
            logger.debug("Background sync triggered...")
            run_sync(verbose=False)
            logger.debug("Background sync completed")
        except Exception as e:
            logger.error(f"Background sync failed: {e}")

    thread = Thread(target=_sync, daemon=True)
    thread.start()


def start_sync_watcher():
    """Start the Rust background sync watcher."""
    global sync_watcher
    if sync_watcher is not None and sync_watcher.is_running():
        logger.warning("Sync watcher already running")
        return

    sync_watcher = core.SyncWatcher()
    sync_watcher.start(CHAT_DB_PATH, APP_DB_PATH)
    logger.info("Rust sync watcher started (polling every 500ms)")


def stop_sync_watcher():
    """Stop the Rust background sync watcher."""
    global sync_watcher
    if sync_watcher is not None:
        sync_watcher.stop()
        logger.info("Rust sync watcher stopped")
        sync_watcher = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan handler for startup/shutdown."""
    # Check if we already have data - if so, skip blocking sync
    if has_existing_data():
        logger.info("Existing data found, skipping initial sync screen")
        sync_status.mark_initial_sync_complete()
        # Still trigger a background sync to catch any new messages
        trigger_background_sync()
    else:
        # First launch: Run blocking sync so frontend waits
        logger.info("No existing data, running initial sync...")
        try:
            run_sync(verbose=True)
        except Exception as e:
            logger.error(f"Initial sync failed: {e}")
            # Mark as complete even on error so frontend can proceed
            sync_status.mark_initial_sync_complete()

    # Start the Rust background sync watcher for near-real-time message updates
    start_sync_watcher()

    yield

    # Cleanup: stop the sync watcher
    stop_sync_watcher()


app = FastAPI(lifespan=lifespan)


@app.get("/")
def root():
    return {"message": "PRM API"}


@app.get("/test/normalize-phone/{phone}")
def normalize_phone(phone: str):
    return {"original": phone, "normalized": core.normalize_phone(phone)}


@app.get("/sync/status")
def get_sync_status():
    """Get current sync status."""
    return sync_status.to_dict()


@app.post("/sync")
def manual_sync():
    """Manually trigger a sync."""
    if not sync_status.try_start_sync():
        return {"success": False, "error": "Sync already in progress"}
    start = time.time()
    error = None
    try:
        sync_all(verbose=False)
        return {"success": True, "message": "Sync completed"}
    except Exception as e:
        error = str(e)
        return {"success": False, "error": error}
    finally:
        sync_status.end_sync(time.time() - start, error)


# Import the sync trigger into chats module so it syncs on every request
chats.trigger_background_sync = trigger_background_sync

app.include_router(chats.router, prefix="/chats")


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
