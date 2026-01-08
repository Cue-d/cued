"""Unanswered message scanner job.

Scans for chats with unanswered messages, applies filters to skip spam/automated,
calculates priority scores, and queues them for LLM analysis.

Schedule: Every 5 minutes
"""

import logging

from services.actions.message_filter import should_skip_llm_analysis
from services.actions.priority import calculate_chat_priority

logger = logging.getLogger(__name__)

# Default threshold for considering a message "unanswered"
UNANSWERED_THRESHOLD_HOURS = 24


def run_unanswered_scan(chat_db, app_db, threshold_hours: int = UNANSWERED_THRESHOLD_HOURS) -> None:
    """Scan for unanswered messages and queue for LLM analysis.

    Args:
        chat_db: ChatDb instance for reading chat.db
        app_db: AppDb instance for prm.db access
        threshold_hours: Hours before a message is considered unanswered
    """
    # Get all chats with unanswered messages from chat.db
    unanswered_chats = chat_db.get_unanswered_chats(threshold_hours)

    if not unanswered_chats:
        logger.debug("[unanswered_scan] No unanswered chats found")
        return

    queued_count = 0
    skipped_count = 0

    for chat in unanswered_chats:
        # Skip if already has pending action
        if app_db.has_pending_action_for_chat(chat["chat_id"], "respond_to_message"):
            continue

        # Skip if recently skipped by LLM
        if app_db.was_recently_skipped(chat["chat_id"]):
            continue

        # Apply heuristic filters to skip spam/automated messages
        filter_result = should_skip_llm_analysis(
            identifier=chat["person_name"],  # Using person_name as identifier proxy
            text=chat["text"],
            person_name=chat["person_name"],
            is_contact=False,  # TODO: Get actual contact status from db
        )

        if filter_result.should_skip:
            # Mark as skipped in the analysis queue
            app_db.mark_analysis_skipped(chat["chat_id"], filter_result.reason.value)
            skipped_count += 1
            logger.debug(
                f"[unanswered_scan] Skipped chat_id={chat['chat_id']} "
                f"reason={filter_result.reason.value}"
            )
            continue

        # Get chat details for priority calculation
        chat_details = chat_db.get_chat(chat["chat_id"])
        is_group = chat_details.is_group if chat_details else False

        # Calculate priority score
        priority = calculate_chat_priority(
            hours_since=chat["hours_since"],
            person=None,  # TODO: Get person details for contact boost
            is_group=is_group,
        )

        # Queue for LLM analysis with message timestamp for recent-first ordering
        app_db.queue_for_analysis(chat["chat_id"], priority, latest_message_ts=chat["timestamp"])
        queued_count += 1
        logger.debug(
            f"[unanswered_scan] Queued chat_id={chat['chat_id']} "
            f"priority={priority} hours_since={chat['hours_since']:.1f}"
        )

    logger.info(
        f"[unanswered_scan] Processed {len(unanswered_chats)} chats: "
        f"{queued_count} queued, {skipped_count} skipped"
    )
