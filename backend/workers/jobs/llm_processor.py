"""LLM queue processor job.

Processes one queued chat through the LLM to generate action suggestions.
Rate-limited to avoid overwhelming the LLM.

Schedule: Every 10 seconds
"""

import logging
import time

from services.actions.llm_client import (
    ContentSafetyError,
    ConversationContext,
    LLMError,
    analyze_conversation,
    is_llm_available,
)
from services.macos.notifications import schedule_action_notification
from workers.scheduler import can_call_llm, mark_llm_called

logger = logging.getLogger(__name__)


def run_llm_processor(chat_db, app_db) -> None:
    """Process the next queued chat through the LLM.

    Args:
        chat_db: ChatDb instance for reading chat.db
        app_db: AppDb instance for prm.db access
    """
    # Check if LLM is available
    if not is_llm_available():
        logger.debug("[llm_processor] LLM binary not available, skipping")
        return

    # Check rate limit
    if not can_call_llm():
        logger.debug("[llm_processor] Rate limited, skipping this cycle")
        return

    # Get next pending analysis
    queued = app_db.get_next_pending_analysis()
    if not queued:
        logger.debug("[llm_processor] No pending analysis in queue")
        return

    chat_id = queued.chat_id

    # Mark as started
    app_db.mark_analysis_started(chat_id)

    # Get messages for context from chat.db
    messages = chat_db.get_chat_messages(chat_id, limit=10)
    if not messages:
        app_db.mark_analysis_complete(chat_id, "no_messages")
        logger.debug(f"[llm_processor] No messages for chat_id={chat_id}")
        return

    # Get participants for person name
    participants = chat_db.get_chat_participants(chat_id)
    person_name = None
    if participants and len(participants) == 1:
        person_name = participants[0]["identifier"]

    # Get the most recent message (for timestamp calculation)
    latest_msg = messages[0] if messages else None
    hours_since = 0.0
    if latest_msg and latest_msg.timestamp:
        hours_since = (time.time() - latest_msg.timestamp) / 3600

    # Build conversation context
    ctx = ConversationContext(
        chat_id=chat_id,
        person_id=None,  # Not available from the analysis queue
        person_name=person_name,
        person_company=None,
        person_notes=None,
        messages=[
            {
                "text": m.text,
                "is_from_me": m.is_from_me,
                "timestamp": m.timestamp,
                "sender_name": m.sender_name,
            }
            for m in reversed(messages)  # Oldest first for LLM
        ],
        hours_since_last=hours_since,
    )

    # Call LLM and mark that we made a call (for rate limiting)
    mark_llm_called()

    try:
        suggestion = analyze_conversation(ctx)

        if suggestion is None:
            # LLM said no action needed
            app_db.mark_analysis_complete(chat_id, "no_action")
            logger.info(f"[llm_processor] No action needed for chat_id={chat_id}")
            return

        # Create action from suggestion (with deduplication check)
        action_id, created = app_db.create_action_if_not_exists(
            action_type=suggestion.action_type,
            chat_id=chat_id,
            priority=suggestion.priority,
            person_id=None,  # TODO: Get person_id if available
            message_id=latest_msg.id if latest_msg else None,
            payload=suggestion.reason,
            remind_at=suggestion.remind_at,
        )

        if not created:
            app_db.mark_analysis_complete(chat_id, "duplicate_action")
            logger.info(
                f"[llm_processor] Duplicate action skipped: "
                f"type={suggestion.action_type} chat_id={chat_id} "
                f"existing_action_id={action_id}"
            )
            return

        app_db.mark_analysis_complete(chat_id, "action_created")
        logger.info(
            f"[llm_processor] Created action_id={action_id} "
            f"type={suggestion.action_type} for chat_id={chat_id}"
        )

        # Schedule desktop notification if remind_at is set
        if suggestion.remind_at and action_id:
            message_preview = latest_msg.text if latest_msg else None
            schedule_action_notification(
                action_id=action_id,
                remind_at=suggestion.remind_at,
                action_type=suggestion.action_type,
                person_name=person_name,
                message_preview=message_preview,
            )

    except ContentSafetyError:
        # Content was flagged - expected, don't retry
        app_db.mark_analysis_complete(chat_id, "content_flagged")
        logger.debug(f"[llm_processor] Content flagged for chat_id={chat_id}")

    except LLMError as e:
        # LLM call failed - will retry next cycle
        app_db.mark_analysis_complete(chat_id, "error")
        logger.warning(f"[llm_processor] LLM error for chat_id={chat_id}: {e}")
