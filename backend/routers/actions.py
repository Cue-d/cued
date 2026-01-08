"""Actions router - swipeable action cards with LLM integration.

Uses ChatDb for message context, AppDb for action storage.
"""

import json
import logging
import time
from enum import Enum

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db.models import ActionWithContext
from deps import get_app_db, get_chat_db
from services.contacts import ContactResolver, get_chat_display_name

logger = logging.getLogger(__name__)
router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================


class ActionType(str, Enum):
    RESPOND_TO_MESSAGE = "respond_to_message"
    EOD_CONTACT = "eod_contact"
    FOLLOW_UP = "follow_up"


class SwipeDirection(str, Enum):
    RIGHT = "right"
    LEFT = "left"
    UP = "up"


class CreateActionRequest(BaseModel):
    type: ActionType
    priority: int = 50
    chat_id: int | None = None
    person_id: int | None = None
    message_id: int | None = None
    payload: dict | None = None
    remind_at: int | None = None


class ActionSwipeRequest(BaseModel):
    direction: SwipeDirection
    snooze_minutes: int | None = None
    response_text: str | None = None


class AttachmentResponse(BaseModel):
    id: int
    filename: str | None = None
    mime_type: str | None = None
    size: int | None = None
    is_image: bool = False


class MessageResponse(BaseModel):
    id: int
    text: str | None = None
    date: int
    is_from_me: bool
    is_read: bool
    date_read: int | None = None
    sender_name: str | None = None
    # Delivery status fields
    is_sent: bool = True
    is_delivered: bool = False
    date_delivered: int | None = None
    error: int = 0
    attachments: list[AttachmentResponse] = []


class ActionResponse(BaseModel):
    id: int
    type: str
    status: str
    priority: int
    chat_id: int | None = None
    person_id: int | None = None
    message_id: int | None = None
    payload: dict | None = None
    created_at: int
    remind_at: int | None = None
    snoozed_until: int | None = None
    completed_at: int | None = None
    discarded_at: int | None = None
    chat_name: str | None = None
    person_name: str | None = None
    message_text: str | None = None
    message_timestamp: int | None = None
    recent_messages: list[MessageResponse] = []


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def _is_image_mime_type(mime_type: str | None) -> bool:
    """Check if a MIME type is an image."""
    if not mime_type:
        return False
    return mime_type.startswith("image/")


def enrich_action_context(
    action: ActionWithContext, chat_db, resolver: ContactResolver
) -> ActionWithContext:
    """Enrich action with context from ChatDb, resolving contact names."""
    if action.chat_id:
        chat = chat_db.get_chat(action.chat_id)

        # Get participants to find person name
        participants = chat_db.get_chat_participants(action.chat_id)
        handle_ids = [p["identifier"] for p in participants]

        # Batch lookup contact names
        handle_to_name = resolver.resolve_handles(handle_ids)

        # Set chat name using shared helper
        if chat:
            action.chat_name = get_chat_display_name(chat, handle_to_name, handle_ids)

        # Set person name (for 1:1 chats, use resolved contact name)
        if participants and len(participants) == 1:
            identifier = participants[0]["identifier"]
            action.person_name = handle_to_name.get(identifier, identifier)

    if action.message_id:
        message = chat_db.get_message(action.message_id)
        if message:
            action.message_text = message.text
            action.message_timestamp = message.timestamp

    return action


def action_to_response(
    action: ActionWithContext, chat_db, resolver: ContactResolver
) -> ActionResponse:
    """Convert ActionWithContext to ActionResponse with recent messages."""
    recent_messages: list[MessageResponse] = []

    if action.chat_id:
        messages = chat_db.get_chat_messages(action.chat_id, 5)

        # Batch resolve sender names
        handle_to_name = resolver.resolve_sender_names(messages)

        for m in messages:
            # Fetch attachments for this message
            attachments_list = chat_db.get_message_attachments(m.id) if m.has_attachments else []
            attachments = [
                AttachmentResponse(
                    id=a["id"],
                    filename=a["filename"],
                    mime_type=a["mime_type"],
                    size=a["size"],
                    is_image=_is_image_mime_type(a["mime_type"]),
                )
                for a in attachments_list
            ]

            # Resolve sender name from contacts
            sender_name = m.sender_name
            if sender_name and not m.is_from_me:
                sender_name = handle_to_name.get(m.sender_name, m.sender_name)

            recent_messages.append(
                MessageResponse(
                    id=m.id,
                    text=m.text,
                    date=m.timestamp,
                    is_from_me=m.is_from_me,
                    is_read=m.is_read,
                    date_read=m.read_at,
                    sender_name=sender_name,
                    is_sent=True,
                    is_delivered=m.is_from_me,
                    date_delivered=m.timestamp if m.is_from_me else None,
                    error=0,
                    attachments=attachments,
                )
            )

    # Parse payload JSON
    payload = None
    if action.payload:
        try:
            payload = json.loads(action.payload)
        except json.JSONDecodeError:
            payload = None

    return ActionResponse(
        id=action.id,
        type=action.type,
        status=action.status,
        priority=action.priority,
        chat_id=action.chat_id,
        person_id=action.person_id,
        message_id=action.message_id,
        payload=payload,
        created_at=action.created_at,
        remind_at=action.remind_at,
        snoozed_until=action.snoozed_until,
        completed_at=action.completed_at,
        discarded_at=action.discarded_at,
        chat_name=action.chat_name,
        person_name=action.person_name,
        message_text=action.message_text,
        message_timestamp=action.message_timestamp,
        recent_messages=recent_messages,
    )


# =============================================================================
# ENDPOINTS
# =============================================================================


@router.get("/", response_model=list[ActionResponse])
def get_actions(
    status: str = "pending",
    action_type: str | None = None,
    limit: int = 50,
):
    """Get actions by status and optionally by type.

    Args:
        status: Filter by status (pending, completed, discarded, snoozed)
        action_type: Filter by action type (respond_to_message, eod_contact, follow_up)
        limit: Maximum number of actions to return
    """
    logger.debug(f"GET /actions/ called: status={status}, action_type={action_type}, limit={limit}")

    try:
        app_db = get_app_db()
        chat_db = get_chat_db()
        resolver = ContactResolver(app_db)
    except Exception as e:
        logger.error(f"Failed to initialize databases: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database error: {e}") from None

    try:
        if status == "pending":
            actions = app_db.get_pending_actions()
        else:
            # For other statuses, we'd need a different query
            # For now, just return pending
            actions = app_db.get_pending_actions()
        logger.debug(f"Fetched {len(actions)} actions")
    except Exception as e:
        logger.error(f"Failed to fetch actions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database query error: {e}") from None

    try:
        actions = [enrich_action_context(a, chat_db, resolver) for a in actions]
    except Exception as e:
        logger.error(f"Failed to enrich actions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Context enrichment error: {e}") from None

    # Apply type filter if specified
    if action_type:
        actions = [a for a in actions if a.type == action_type]

    # Apply limit
    actions = actions[:limit]

    try:
        result = [action_to_response(a, chat_db, resolver) for a in actions]
        logger.debug(f"GET /actions/ returning {len(result)} actions")
        return result
    except Exception as e:
        logger.error(f"Failed to build responses: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Response building error: {e}") from None


@router.get("/{action_id}", response_model=ActionResponse)
def get_action(action_id: int):
    """Get single action with context."""
    app_db = get_app_db()
    chat_db = get_chat_db()
    resolver = ContactResolver(app_db)

    action = app_db.get_action(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    action = enrich_action_context(action, chat_db, resolver)
    return action_to_response(action, chat_db, resolver)


@router.post("/", response_model=ActionResponse)
def create_action(request: CreateActionRequest):
    """Create a new action."""
    app_db = get_app_db()
    chat_db = get_chat_db()
    resolver = ContactResolver(app_db)

    payload_json = json.dumps(request.payload) if request.payload else None
    action_id = app_db.create_action(
        action_type=request.type.value,
        priority=request.priority,
        chat_id=request.chat_id,
        person_id=request.person_id,
        message_id=request.message_id,
        payload=payload_json,
        remind_at=request.remind_at,
    )
    action = app_db.get_action(action_id)
    action = enrich_action_context(action, chat_db, resolver)
    return action_to_response(action, chat_db, resolver)


@router.post("/{action_id}/swipe", response_model=ActionResponse)
def swipe_action(action_id: int, request: ActionSwipeRequest):
    """Handle swipe gesture on action card."""
    app_db = get_app_db()
    chat_db = get_chat_db()
    resolver = ContactResolver(app_db)

    action = app_db.get_action(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    if request.direction == SwipeDirection.LEFT:
        # Discard
        app_db.update_action_status(action_id, "discarded")

    elif request.direction == SwipeDirection.RIGHT:
        # Complete - also send message if provided
        if request.response_text and action.chat_id:
            try:
                from services.macos.messaging import send_message, send_to_group

                # Get chat to determine if group
                chat = chat_db.get_chat(action.chat_id)
                if chat and chat.is_group:
                    send_to_group(chat.identifier, request.response_text)
                elif chat:
                    send_message(chat.identifier, request.response_text)
            except Exception as e:
                logger.error(f"Failed to send message: {e}")
        app_db.update_action_status(action_id, "completed")

    elif request.direction == SwipeDirection.UP:
        # Snooze
        snooze_until = None
        if request.snooze_minutes:
            snooze_until = int(time.time()) + (request.snooze_minutes * 60)
        app_db.update_action_status(action_id, "snoozed", snooze_until)

    action = app_db.get_action(action_id)
    action = enrich_action_context(action, chat_db, resolver)
    return action_to_response(action, chat_db, resolver)


@router.delete("/{action_id}")
def delete_action(action_id: int):
    """Delete an action."""
    app_db = get_app_db()
    app_db.delete_action(action_id)
    return {"success": True}


@router.post("/generate/unanswered")
def generate_unanswered_actions(threshold_hours: int = 24):
    """Scan for unanswered messages and create respond_to_message actions.

    Args:
        threshold_hours: Only create actions for messages unanswered longer than this
    """
    app_db = get_app_db()
    chat_db = get_chat_db()

    # Get unanswered chats from ChatDb
    unanswered = chat_db.get_unanswered_chats(threshold_hours)

    created = 0
    for chat in unanswered:
        # Skip if already has pending action
        if app_db.has_pending_action_for_chat(chat["chat_id"], "respond_to_message"):
            continue

        # Skip if recently skipped by LLM
        if app_db.was_recently_skipped(chat["chat_id"]):
            continue

        payload = json.dumps(
            {
                "message_preview": (chat["text"] or "")[:100],
                "hours_since": chat["hours_since"],
            }
        )

        app_db.create_action(
            action_type="respond_to_message",
            priority=60,  # Higher than EOD contacts (50)
            chat_id=chat["chat_id"],
            person_id=chat["sender_id"],
            message_id=chat["message_id"],
            payload=payload,
        )
        created += 1

    logger.info(f"Generated {created} unanswered message actions (threshold: {threshold_hours}h)")
    return {"success": True, "actions_created": created}
