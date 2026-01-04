from enum import Enum

from pydantic import BaseModel


class ChatResponse(BaseModel):
    id: int
    name: str
    last_message: str | None
    last_message_date: int
    is_group: bool
    handle_ids: list[str]
    member_names: list[str]  # Resolved names for group avatars


class MessageResponse(BaseModel):
    id: int
    text: str | None
    date: int
    is_from_me: bool
    is_read: bool
    date_read: int | None
    sender_name: str | None


class SendMessageRequest(BaseModel):
    text: str


class SendMessageResponse(BaseModel):
    success: bool
    error: str | None = None


class ActionType(str, Enum):
    RESPOND_TO_MESSAGE = "respond_to_message"
    EOD_CONTACT = "eod_contact"
    FOLLOW_UP = "follow_up"


class ActionStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    DISCARDED = "discarded"
    SNOOZED = "snoozed"


class SwipeDirection(str, Enum):
    RIGHT = "right"  # Complete/Take action
    LEFT = "left"  # Discard
    UP = "up"  # Snooze


class ActionResponse(BaseModel):
    id: int
    type: ActionType
    status: ActionStatus
    priority: int
    chat_id: int | None
    person_id: int | None
    message_id: int | None
    payload: dict | None
    created_at: int
    remind_at: int | None
    snoozed_until: int | None
    completed_at: int | None
    discarded_at: int | None
    chat_name: str | None
    person_name: str | None
    message_text: str | None
    message_timestamp: int | None
    recent_messages: list[MessageResponse] = []  # Last 5 for context


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


class SearchResultResponse(BaseModel):
    message_id: int
    chat_id: int
    text: str
    timestamp: int
    sender_name: str | None
    chat_name: str | None
    rank: float


class EODContactResponse(BaseModel):
    person_id: int
    identifier: str
    name: str
    is_contact: bool
