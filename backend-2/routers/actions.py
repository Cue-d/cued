from fastapi import APIRouter
from datetime import datetime
from typing import Optional

router = APIRouter()


@router.get("/")
def get_actions(status: str = "pending", limit: int = 50, action_type: Optional[str] = None):
    """List actions - dummy implementation"""
    actions = [
        {
            "id": i,
            "action_type": "respond_to_message" if i % 2 == 0 else "new_contact",
            "status": status,
            "priority": 50 + (i % 50),
            "context": {
                "chat_id": i * 10,
                "message_text": f"Message requiring action {i}",
                "person_name": f"Contact {i}",
            },
            "created_at": datetime.now().isoformat(),
            "snoozed_until": None,
            "recent_messages": [],
        }
        for i in range(min(limit, 15))
    ]

    if action_type:
        actions = [a for a in actions if a["action_type"] == action_type]

    return actions


@router.post("/{action_id}/swipe")
def swipe_action(action_id: int, payload: dict):
    """Swipe an action card - dummy implementation"""
    direction = payload.get("direction", "right")
    new_status = {
        "right": "completed",
        "left": "discarded",
        "up": "snoozed",
    }.get(direction, "completed")

    return {
        "id": action_id,
        "action_type": "respond_to_message",
        "status": new_status,
        "priority": 75,
        "context": {
            "chat_id": action_id * 10,
            "message_text": f"Message for action {action_id}",
        },
        "created_at": datetime.now().isoformat(),
        "snoozed_until": None,
    }
