import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from threading import Lock, Thread

import core
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import actions, chats, eod, search
from sync_db import APP_DB_PATH, CHAT_DB_PATH, sync_all

logger = logging.getLogger(__name__)

# Global sync watcher instance (Rust background thread)
sync_watcher: core.SyncWatcher | None = None

# Background scheduler for periodic jobs
scheduler: BackgroundScheduler | None = None


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


def run_unanswered_scan():
    """Background job: Scan for unanswered messages and create actions using LLM."""
    try:
        db = core.AppDb(APP_DB_PATH)
        db.init_schema()
        unanswered = db.get_unanswered_chats(24)  # 24 hour threshold

        if not unanswered:
            return

        import json

        from services.llm_client import (
            LLMError,
            is_llm_available,
        )

        # Try LLM-based generation if available
        if is_llm_available():
            try:
                created = _run_llm_action_generation(db, unanswered)
                if created > 0:
                    logger.info(f"Background job: LLM created {created} action suggestions")
                return
            except LLMError as e:
                logger.warning(f"LLM generation failed, falling back to heuristics: {e}")

        # Fallback: heuristic-based generation
        created = 0
        for chat in unanswered:
            payload = json.dumps(
                {
                    "message_preview": (chat.text or "")[:100],
                    "hours_since": chat.hours_since,
                }
            )
            db.create_action(
                action_type="respond_to_message",
                priority=60,
                chat_id=chat.chat_id,
                person_id=chat.sender_id,
                message_id=chat.message_id,
                payload=payload,
                remind_at=None,
            )
            created += 1

        if created > 0:
            logger.info(f"Background job: Created {created} unanswered message actions (heuristic)")
    except Exception as e:
        logger.error(f"Unanswered scan failed: {e}")


def _run_llm_action_generation(db, unanswered_chats) -> int:
    """Run LLM-based action generation with full conversation context."""
    import json

    from services.llm_client import ConversationContext, generate_actions

    # Build conversation contexts with full data
    contexts = []
    for chat in unanswered_chats:
        # TOOD: Add RAG context plus recent context.
        # Get recent messages for context (last 10)
        messages = db.get_chat_messages(chat.chat_id, 10)

        # Get person info if available
        person = None
        if chat.sender_id:
            person = db.get_person(chat.sender_id)

        ctx = ConversationContext(
            chat_id=chat.chat_id,
            person_id=person.id if person else None,
            person_name=person.name if person else None,
            person_company=person.company if person else None,
            person_notes=person.notes if person else None,
            messages=[
                {
                    "text": m.text,
                    "is_from_me": m.is_from_me,
                    "timestamp": m.timestamp,
                    "sender_name": m.sender_name,  # For group chats
                }
                for m in messages
            ],
            hours_since_last=chat.hours_since,
        )
        contexts.append(ctx)

    # Call LLM
    suggestions = generate_actions(contexts)

    # Create actions from LLM suggestions
    created = 0
    for suggestion in suggestions:
        payload = json.dumps({"reason": suggestion.reason})
        db.create_action(
            action_type=suggestion.action_type,
            priority=suggestion.priority,
            chat_id=suggestion.chat_id,
            person_id=None,  # Could look up from chat if needed
            message_id=None,
            payload=payload,
            remind_at=suggestion.remind_at,
        )
        created += 1

    return created


def run_eod_scan():
    """Background job: Scan for new contacts texted today and create EOD actions."""
    try:
        db = core.AppDb(APP_DB_PATH)
        db.init_schema()
        new_contacts = db.get_todays_new_contacts()

        import json

        created = 0
        for person in new_contacts:
            if db.has_eod_action_today(person.id):
                continue

            payload = json.dumps(
                {
                    "identifier": person.identifier,
                    "is_contact": person.is_contact,
                }
            )
            db.create_action(
                action_type="eod_contact",
                priority=50,
                chat_id=None,
                person_id=person.id,
                message_id=None,
                payload=payload,
                remind_at=None,
            )
            created += 1

        if created > 0:
            logger.info(f"Background job: Created {created} EOD contact actions")
    except Exception as e:
        logger.error(f"EOD scan failed: {e}")


def run_embedding_batch():
    """Background job: Process a batch of messages for embedding generation."""
    try:
        # Import here to avoid loading model on startup
        from embedding_worker import process_embedding_queue

        processed = process_embedding_queue(batch_size=50)
        if processed > 0:
            logger.debug(f"Background job: Processed {processed} embeddings")
    except ImportError:
        # embedding_worker not available yet
        pass
    except Exception as e:
        logger.error(f"Embedding batch failed: {e}")


def start_scheduler():
    """Start the background job scheduler."""
    global scheduler
    if scheduler is not None and scheduler.running:
        logger.warning("Scheduler already running")
        return

    scheduler = BackgroundScheduler()

    # Scan for unanswered messages every 6 hours
    scheduler.add_job(run_unanswered_scan, "interval", minutes=1, id="unanswered_scan")

    # EOD contact scan at 9 PM daily
    scheduler.add_job(run_eod_scan, "cron", hour=21, id="eod_scan")

    # Process embeddings every 5 minutes (if worker is available)
    scheduler.add_job(run_embedding_batch, "interval", minutes=5, id="embedding_batch")

    scheduler.start()
    logger.info("Background scheduler started (unanswered scan: 6h, EOD: 9PM, embeddings: 5min)")


def stop_scheduler():
    """Stop the background job scheduler."""
    global scheduler
    if scheduler is not None:
        scheduler.shutdown()
        logger.info("Background scheduler stopped")
        scheduler = None


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

    # Generate initial actions from unanswered messages on startup
    logger.info("Running initial unanswered message scan...")
    run_unanswered_scan()

    # Start the background scheduler for periodic jobs
    start_scheduler()

    yield

    # Cleanup: stop the scheduler and sync watcher
    stop_scheduler()
    stop_sync_watcher()


app = FastAPI(lifespan=lifespan)

# CORS middleware for Electron frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Electron uses file:// or localhost with various ports
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
app.include_router(actions.router, prefix="/actions")
app.include_router(search.router, prefix="/search")
app.include_router(eod.router, prefix="/eod")


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
