"""SQLModel models for PRM database."""

from sqlmodel import Field, Relationship, SQLModel

# =============================================================================
# PRM DATABASE MODELS
# =============================================================================


class Handle(SQLModel, table=True):
    """Handle - phone number or email address."""

    __tablename__ = "handles"

    id: int = Field(primary_key=True)
    identifier: str = Field(index=True)  # phone '+12025551234' or email
    service: str  # iMessage, SMS

    messages: list["Message"] = Relationship(back_populates="sender")
    chat_links: list["ChatParticipant"] = Relationship(back_populates="handle")


class Chat(SQLModel, table=True):
    """Conversation - 1:1 or group."""

    __tablename__ = "chats"

    id: int = Field(primary_key=True)
    identifier: str = Field(index=True)  # phone/email for 1:1, 'chat123' for groups
    name: str | None = None  # display_name if set, else computed
    is_group: bool
    synced_at: int

    messages: list["Message"] = Relationship(back_populates="chat")
    participants: list["ChatParticipant"] = Relationship(back_populates="chat")


class ChatParticipant(SQLModel, table=True):
    """Junction: chat participants (many-to-many)."""

    __tablename__ = "chat_participants"

    chat_id: int = Field(foreign_key="chats.id", primary_key=True)
    handle_id: int = Field(foreign_key="handles.id", primary_key=True, index=True)

    chat: Chat = Relationship(back_populates="participants")
    handle: Handle = Relationship(back_populates="chat_links")


class Message(SQLModel, table=True):
    """Message with pre-resolved sender."""

    __tablename__ = "messages"

    id: int = Field(primary_key=True)
    chat_id: int = Field(foreign_key="chats.id", index=True)
    sender_id: int | None = Field(default=None, foreign_key="handles.id")
    text: str | None = None
    timestamp: int = Field(index=True)
    is_from_me: bool
    is_read: bool
    read_at: int | None = None
    has_attachments: bool = False
    synced_at: int

    chat: Chat = Relationship(back_populates="messages")
    sender: Handle | None = Relationship(back_populates="messages")
    attachments: list["Attachment"] = Relationship(back_populates="message")


class Attachment(SQLModel, table=True):
    """Attachment metadata."""

    __tablename__ = "attachments"

    id: int = Field(primary_key=True)
    message_id: int = Field(foreign_key="messages.id", index=True)
    filename: str | None = None
    path: str | None = None
    mime_type: str | None = None
    uti: str | None = None
    size: int | None = None
    is_outgoing: bool
    created_at: int | None = None
    synced_at: int

    message: Message = Relationship(back_populates="attachments")


# =============================================================================
# RESPONSE MODELS (for API)
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
# ACTION MODELS
# =============================================================================


class Action(SQLModel, table=True):
    """Action queue item for swipeable cards."""

    __tablename__ = "actions"

    id: int | None = Field(default=None, primary_key=True)
    type: str = Field(index=True)  # respond_to_message, eod_contact, follow_up
    status: str = Field(default="pending", index=True)  # pending, completed, discarded, snoozed
    priority: int = Field(default=50)
    chat_id: int | None = Field(default=None, foreign_key="chats.id")
    person_id: int | None = Field(default=None)  # References people table (if exists)
    message_id: int | None = Field(default=None, foreign_key="messages.id")
    payload: str | None = None  # JSON string
    created_at: int
    remind_at: int | None = None
    snoozed_until: int | None = None
    completed_at: int | None = None
    discarded_at: int | None = None


class LlmAnalysisQueue(SQLModel, table=True):
    """Queue for LLM conversation analysis."""

    __tablename__ = "llm_analysis_queue"

    chat_id: int = Field(primary_key=True, foreign_key="chats.id")
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
    # Joined fields
    chat_name: str | None = None
    person_name: str | None = None
    message_text: str | None = None
    message_timestamp: int | None = None


class UnansweredChat(SQLModel):
    """Chat with unanswered message info."""

    message_id: int
    chat_id: int
    sender_id: int | None = None
    text: str | None = None
    timestamp: int
    chat_name: str | None = None
    person_name: str | None = None
    hours_since: int


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
