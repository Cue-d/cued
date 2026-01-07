import json
import logging

import core
from fastapi import APIRouter, HTTPException

from schemas import (
    ActionResponse,
    ActionSwipeRequest,
    AttachmentResponse,
    CreateActionRequest,
    MessageResponse,
)
from sync_db import APP_DB_PATH
from utils import is_image_mime_type

logger = logging.getLogger(__name__)
router = APIRouter()


def get_db():
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    return db


def action_to_response(action, db) -> ActionResponse:
    """Convert Action from Rust to ActionResponse with recent messages."""
    recent_messages = []
    if action.chat_id:
        messages = db.get_chat_messages(action.chat_id, 5)
        message_ids = [m.id for m in messages]

        # Batch fetch attachments for all messages
        attachments_map = db.get_attachments_for_messages(message_ids) if message_ids else {}

        for m in messages:
            # Build attachments list
            msg_attachments = attachments_map.get(m.id, [])
            attachments = [
                AttachmentResponse(
                    id=a.id,
                    filename=a.filename,
                    mime_type=a.mime_type,
                    size=a.size,
                    is_image=is_image_mime_type(a.mime_type),
                )
                for a in msg_attachments
            ]

            recent_messages.append(
                MessageResponse(
                    id=m.id,
                    text=m.text,
                    date=m.timestamp,
                    is_from_me=m.is_from_me,
                    is_read=m.is_read,
                    date_read=m.read_at,
                    sender_name=m.sender_name,
                    attachments=attachments,
                )
            )

    return ActionResponse(
        id=action.id,
        type=action.action_type,
        status=action.status,
        priority=action.priority,
        chat_id=action.chat_id,
        person_id=action.person_id,
        message_id=action.message_id,
        payload=json.loads(action.payload) if action.payload else None,
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
    db = get_db()
    if status == "pending":
        actions = db.get_pending_actions(limit)
    else:
        # For other statuses, we'd need a different query
        # For now, just return pending
        actions = db.get_pending_actions(limit)

    # Apply type filter if specified
    if action_type:
        actions = [a for a in actions if a.action_type == action_type]

    return [action_to_response(a, db) for a in actions]


@router.get("/{action_id}", response_model=ActionResponse)
def get_action(action_id: int):
    """Get single action with context."""
    db = get_db()
    action = db.get_action(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return action_to_response(action, db)


@router.post("/", response_model=ActionResponse)
def create_action(request: CreateActionRequest):
    """Create a new action."""
    db = get_db()
    payload_json = json.dumps(request.payload) if request.payload else None
    action_id = db.create_action(
        action_type=request.type.value,
        priority=request.priority,
        chat_id=request.chat_id,
        person_id=request.person_id,
        message_id=request.message_id,
        payload=payload_json,
        remind_at=request.remind_at,
    )
    action = db.get_action(action_id)
    return action_to_response(action, db)


@router.post("/{action_id}/swipe", response_model=ActionResponse)
def swipe_action(action_id: int, request: ActionSwipeRequest):
    """Handle swipe gesture on action card."""
    db = get_db()
    action = db.get_action(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    import time

    if request.direction.value == "left":
        # Discard
        db.update_action_status(action_id, "discarded", None)
    elif request.direction.value == "right":
        # Complete - also send message if provided
        if request.response_text and action.chat_id:
            try:
                # Get chat to determine if group
                chat = db.get_chat(action.chat_id)
                if chat and chat.is_group:
                    core.send_to_group(chat.identifier, request.response_text)
                elif chat:
                    core.send_message(chat.identifier, request.response_text)
            except Exception as e:
                logger.error(f"Failed to send message: {e}")
        db.update_action_status(action_id, "completed", None)
    elif request.direction.value == "up":
        # Snooze
        snooze_until = None
        if request.snooze_minutes:
            snooze_until = int(time.time()) + (request.snooze_minutes * 60)
        db.update_action_status(action_id, "snoozed", snooze_until)

    action = db.get_action(action_id)
    return action_to_response(action, db)


@router.delete("/{action_id}")
def delete_action(action_id: int):
    """Delete an action."""
    db = get_db()
    db.delete_action(action_id)
    return {"success": True}


@router.post("/generate/unanswered")
def generate_unanswered_actions(threshold_hours: int = 24):
    """Scan for unanswered messages and create respond_to_message actions.

    Args:
        threshold_hours: Only create actions for messages unanswered longer than this
    """
    db = get_db()
    unanswered = db.get_unanswered_chats(threshold_hours)

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
            priority=60,  # Higher than EOD contacts (50)
            chat_id=chat.chat_id,
            person_id=chat.sender_id,
            message_id=chat.message_id,
            payload=payload,
            remind_at=None,
        )
        created += 1

    logger.info(f"Generated {created} unanswered message actions (threshold: {threshold_hours}h)")
    return {"success": True, "actions_created": created}
