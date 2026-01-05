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

# ============================================
# CHAT PRIORITY CALCULATION
# ============================================
# Priority scoring for LLM analysis queue (0-100 scale, higher = processed sooner).
# Uses a time-decay curve and contact importance signals.


def _calculate_time_priority(hours_since: float) -> int:
    """
    Calculate priority based on time since last message using a curve.

    The "Goldilocks zone" is 2-72 hours:
    - 0-2 hours: Low priority (still in active conversation, don't interrupt)
    - 2-24 hours: Ramping up (conversation cooling, may need follow-up)
    - 24-72 hours: Peak priority (definitely needs attention)
    - 72-168 hours (3-7 days): Declining (getting stale)
    - 168+ hours: Low priority (probably too late to matter much)

    Returns: priority component (20-80)
    """
    if hours_since < 2:
        return 20  # Too fresh
    elif hours_since < 24:
        # Ramp from 40 to 70 over 22 hours
        return int(40 + (hours_since - 2) * (30 / 22))
    elif hours_since < 72:
        return 80  # Peak urgency zone
    elif hours_since < 168:  # 1 week
        # Decay from 80 to 40 over 96 hours
        return int(80 - (hours_since - 72) * (40 / 96))
    else:
        return 30  # Very old, low priority


def _calculate_contact_priority_boost(person) -> int:
    """
    Calculate priority boost based on contact importance.

    Saved contacts with metadata are likely more important relationships.

    Args:
        person: core.Person object or None

    Returns: priority boost (0-25)
    """
    if person is None:
        return 0

    boost = 0

    # Saved contacts are more important than unknown numbers
    if person.is_contact:
        boost += 10

    # Company field suggests professional relationship
    if person.company:
        boost += 10

    # Notes suggest you've documented this relationship
    if person.notes:
        boost += 5

    return boost


def _calculate_group_penalty(is_group: bool) -> int:
    """
    Calculate priority penalty for group chats.

    Group chats are often less actionable - someone else may respond.

    Returns: penalty (negative value, -15 for groups)
    """
    return -15 if is_group else 0


def calculate_chat_priority(
    hours_since: float,
    person=None,
    is_group: bool = False,
) -> int:
    """
    Calculate overall priority score for a chat's LLM analysis.

    Combines:
    - Time-decay curve (base priority)
    - Contact importance boost
    - Group chat penalty

    Args:
        hours_since: Hours since last message from them
        person: core.Person object or None
        is_group: Whether this is a group chat

    Returns: priority score (10-100)
    """
    # Base priority from time curve (20-80)
    priority = _calculate_time_priority(hours_since)

    # Add contact importance boost (0-25)
    priority += _calculate_contact_priority_boost(person)

    # Apply group penalty (-15 or 0)
    priority += _calculate_group_penalty(is_group)

    # Clamp to valid range
    return max(10, min(100, priority))


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
    """Background job: Queue unanswered chats for LLM analysis (non-blocking).

    Uses smart priority scoring based on:
    - Time-decay curve (peak at 24-72 hours, declining after)
    - Contact importance (saved contacts, company, notes)
    - Group chat penalty (less actionable)
    """
    try:
        db = core.AppDb(APP_DB_PATH)
        db.init_schema()
        unanswered = db.get_unanswered_chats(24)  # 24 hour threshold

        if not unanswered:
            return

        # Queue chats for analysis with smart priority scoring
        queued = 0
        for chat in unanswered:
            # Get chat and person info for priority calculation
            chat_info = db.get_chat(chat.chat_id)
            is_group = chat_info.is_group if chat_info else False

            # Get first participant for contact importance scoring
            participants = db.get_chat_participants(chat.chat_id)
            person = participants[0] if participants else None

            # Calculate priority using time-decay curve + contact signals
            priority = calculate_chat_priority(
                hours_since=float(chat.hours_since),
                person=person,
                is_group=is_group,
            )

            db.queue_for_analysis(chat.chat_id, priority)
            queued += 1

        if queued > 0:
            logger.debug(f"Background job: Queued {queued} chats for LLM analysis")
    except Exception as e:
        logger.error(f"Unanswered scan failed: {e}")


def _process_single_chat_llm(db, chat_id: int) -> str:
    """Process a single chat with LLM.

    Returns: 'action_created', 'no_action', 'content_flagged', or 'error'
    """
    import json

    from services.llm_client import (
        ContentSafetyError,
        ConversationContext,
        LLMError,
        analyze_conversation,
    )

    try:
        # Get chat info
        chat = db.get_chat(chat_id)
        if not chat:
            return "error"

        # Get recent messages for context (last 10)
        messages = db.get_chat_messages(chat_id, 10)
        if not messages:
            return "no_action"

        # Get first participant for person info
        participants = db.get_chat_participants(chat_id)
        person = participants[0] if participants else None

        # Calculate hours since last message
        latest_ts = max(m.timestamp for m in messages) if messages else 0
        hours_since = (time.time() - latest_ts) / 3600 if latest_ts > 0 else 0

        ctx = ConversationContext(
            chat_id=chat_id,
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
            hours_since_last=hours_since,
        )

        # Call LLM for single conversation
        suggestion = analyze_conversation(ctx)

        if suggestion is None:
            return "no_action"

        # Create action from suggestion
        payload = json.dumps({"reason": suggestion.reason})
        db.create_action(
            action_type=suggestion.action_type,
            priority=suggestion.priority,
            chat_id=suggestion.chat_id,
            person_id=None,
            message_id=None,
            payload=payload,
            remind_at=suggestion.remind_at,
        )
        return "action_created"

    except ContentSafetyError:
        # Content was flagged - this is expected for some conversations, don't retry
        logger.debug(f"Chat {chat_id} content flagged by safety filter, skipping")
        return "content_flagged"
    except LLMError as e:
        logger.warning(f"LLM analysis failed for chat {chat_id}: {e}")
        return "error"
    except Exception as e:
        logger.error(f"Error processing chat {chat_id}: {e}")
        return "error"


# Rate limiting for LLM queue processor
_last_llm_call_time: float = 0
LLM_RATE_LIMIT_SECONDS = 2.0  # Minimum seconds between LLM calls


def run_llm_queue_processor():
    """Background job: Process one item from the LLM analysis queue with rate limiting."""
    global _last_llm_call_time

    try:
        from services.llm_client import is_llm_available

        if not is_llm_available():
            return

        db = core.AppDb(APP_DB_PATH)
        db.init_schema()

        # Get next pending item
        item = db.get_next_pending_analysis()
        if not item:
            return

        # Rate limiting: wait if we called LLM too recently
        now = time.time()
        time_since_last = now - _last_llm_call_time
        if time_since_last < LLM_RATE_LIMIT_SECONDS:
            # Skip this cycle, will try again next interval
            return

        # Mark as processing
        db.mark_analysis_started(item.chat_id)
        _last_llm_call_time = time.time()

        # Process the chat
        result = _process_single_chat_llm(db, item.chat_id)

        # Mark complete with result
        db.mark_analysis_complete(item.chat_id, result)

        if result == "action_created":
            logger.info(f"LLM queue: Created action for chat {item.chat_id}")
        else:
            logger.debug(f"LLM queue: Processed chat {item.chat_id} -> {result}")

    except Exception as e:
        logger.error(f"LLM queue processor failed: {e}")


def run_llm_queue_cleanup():
    """Background job: Clean up old completed analysis entries."""
    try:
        db = core.AppDb(APP_DB_PATH)
        db.init_schema()
        # Clear entries older than 24 hours
        cleared = db.clear_old_analysis(24)
        if cleared > 0:
            logger.debug(f"LLM queue cleanup: Cleared {cleared} old entries")
    except Exception as e:
        logger.error(f"LLM queue cleanup failed: {e}")


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

    # Queue unanswered chats for analysis every 5 minutes (lightweight, just queues)
    scheduler.add_job(run_unanswered_scan, "interval", minutes=5, id="unanswered_scan")

    # Process LLM queue every 10 seconds (rate-limited internally)
    # coalesce=True: If multiple runs are missed, only run once
    # max_instances=1: Only one instance can run at a time (default, suppresses warning)
    # misfire_grace_time=None: Never consider a job "misfired"
    scheduler.add_job(
        run_llm_queue_processor,
        "interval",
        seconds=10,
        id="llm_queue_processor",
        coalesce=True,
        misfire_grace_time=None,
    )

    # Clean up old LLM queue entries every hour
    scheduler.add_job(run_llm_queue_cleanup, "interval", hours=1, id="llm_queue_cleanup")

    # EOD contact scan at 9 PM daily
    scheduler.add_job(run_eod_scan, "cron", hour=21, id="eod_scan")

    # Process embeddings every 5 minutes (if worker is available)
    scheduler.add_job(run_embedding_batch, "interval", minutes=5, id="embedding_batch")

    scheduler.start()
    logger.info("Background scheduler started (queue: 5min, LLM: 3s, EOD: 9PM, embed: 5min)")


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

    # Queue unanswered chats for LLM analysis (non-blocking)
    logger.info("Queueing unanswered chats for analysis...")
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
