from pydantic import BaseModel


class ConversationResponse(BaseModel):
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
