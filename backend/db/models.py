"""SQLModel models for PRM database.

Note: This file only contains response models and the Action/LlmAnalysisQueue tables.
Message/chat data is read directly from chat.db via ChatDb, not stored in prm.db.
"""

from sqlmodel import Field, SQLModel

# =============================================================================
# RESPONSE MODELS (for API - data comes from chat.db)
# =============================================================================


class ChatWithLastMessage(SQLModel):
    """Chat list item with last message preview."""

    id: int
    identifier: str
    name: str | None = None
    is_group: bool
    last_message_text: str | None = None
    last_message_timestamp: int | None = None


class MessageWithSender(SQLModel):
    """Message with sender info for chat views."""

    id: int
    chat_id: int
    sender_id: int | None = None
    sender_name: str | None = None
    text: str | None = None
    timestamp: int
    is_from_me: bool
    is_read: bool
    read_at: int | None = None
    has_attachments: bool = False


# =============================================================================
# ACTION MODELS (stored in prm.db)
# =============================================================================


class Action(SQLModel, table=True):
    """Action queue item for swipeable cards."""

    __tablename__ = "actions"

    id: int | None = Field(default=None, primary_key=True)
    type: str = Field(index=True)  # respond_to_message, eod_contact, follow_up
    status: str = Field(default="pending", index=True)  # pending, completed, discarded, snoozed
    priority: int = Field(default=50)
    chat_id: int | None = Field(default=None)  # References chat.db chat ROWID
    person_id: int | None = Field(default=None)  # References chat.db handle ROWID
    message_id: int | None = Field(default=None)  # References chat.db message ROWID
    payload: str | None = None  # JSON string
    created_at: int
    remind_at: int | None = None
    snoozed_until: int | None = None
    completed_at: int | None = None
    discarded_at: int | None = None


class LlmAnalysisQueue(SQLModel, table=True):
    """Queue for LLM conversation analysis."""

    __tablename__ = "llm_analysis_queue"

    chat_id: int = Field(primary_key=True)  # References chat.db chat ROWID
    status: str = Field(default="pending")  # pending, processing, completed, skipped
    priority: int = Field(default=50)
    queued_at: int
    started_at: int | None = None
    completed_at: int | None = None
    result: str | None = None  # action_created, no_action, error, skipped:<reason>


# =============================================================================
# ACTION RESPONSE MODELS (for API)
# =============================================================================


class ActionWithContext(SQLModel):
    """Action with joined context for API responses."""

    id: int
    type: str
    status: str
    priority: int
    chat_id: int | None = None
    person_id: int | None = None
    message_id: int | None = None
    payload: str | None = None  # JSON string - parsed by router
    created_at: int
    remind_at: int | None = None
    snoozed_until: int | None = None
    completed_at: int | None = None
    discarded_at: int | None = None
    # Joined fields (populated from ChatDb)
    chat_name: str | None = None
    person_name: str | None = None
    message_text: str | None = None
    message_timestamp: int | None = None


class QueuedAnalysis(SQLModel):
    """LLM analysis queue item with context."""

    chat_id: int
    status: str
    priority: int
    queued_at: int
    started_at: int | None = None
    completed_at: int | None = None
    result: str | None = None
    chat_name: str | None = None
    person_name: str | None = None
