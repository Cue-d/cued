"""Search models."""

from sqlmodel import SQLModel


class SearchResult(SQLModel):
    """Search result with message context."""

    message_id: int
    chat_id: int
    text: str
    timestamp: int
    sender_name: str | None = None
    chat_name: str | None = None
    rank: float
