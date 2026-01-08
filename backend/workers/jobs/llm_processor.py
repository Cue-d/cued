"""LLM queue processor job.

Processes one queued chat through the LLM to generate action suggestions.
Rate-limited to avoid overwhelming the LLM.

Schedule: Every 10 seconds
"""

import logging

from services.actions.llm_client import (
    ContentSafetyError,
    ConversationContext,
    LLMError,
    analyze_conversation,
    is_llm_available,
)
from workers.scheduler import can_call_llm, mark_llm_called

logger = logging.getLogger(__name__)


def run_llm_processor(app_db) -> None:
    """Process the next queued chat through the LLM.

    Args:
        app_db: AppDb instance
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

    # Get messages for context
    messages = app_db.get_chat_messages(chat_id, limit=10)
    if not messages:
        app_db.mark_analysis_complete(chat_id, "no_messages")
        logger.debug(f"[llm_processor] No messages for chat_id={chat_id}")
        return

    # Get the most recent message (for timestamp calculation)
    latest_msg = messages[0] if messages else None
    hours_since = 0.0
    if latest_msg and latest_msg.timestamp:
        import time

        hours_since = (time.time() - latest_msg.timestamp) / 3600

    # Build conversation context
    ctx = ConversationContext(
        chat_id=chat_id,
        person_id=queued.person_name,  # Using person_name as proxy for now
        person_name=queued.person_name,
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

        # Create action from suggestion
        action_id = app_db.create_action(
            action_type=suggestion.action_type,
            priority=suggestion.priority,
            chat_id=chat_id,
            person_id=None,  # TODO: Get person_id if available
            message_id=latest_msg.id if latest_msg else None,
            payload=suggestion.reason,
            remind_at=suggestion.remind_at,
        )

        app_db.mark_analysis_complete(chat_id, "action_created")
        logger.info(
            f"[llm_processor] Created action_id={action_id} "
            f"type={suggestion.action_type} for chat_id={chat_id}"
        )

    except ContentSafetyError:
        # Content was flagged - expected, don't retry
        app_db.mark_analysis_complete(chat_id, "content_flagged")
        logger.debug(f"[llm_processor] Content flagged for chat_id={chat_id}")

    except LLMError as e:
        # LLM call failed - will retry next cycle
        app_db.mark_analysis_complete(chat_id, "error")
        logger.warning(f"[llm_processor] LLM error for chat_id={chat_id}: {e}")
