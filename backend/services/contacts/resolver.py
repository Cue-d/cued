"""Contact name resolution service.

Resolves phone/email handles to contact names from the local contacts database.
"""

from db.prm_db import AppDb


class ContactResolver:
    """Resolves handles (phone/email) to contact names.

    Usage:
        resolver = ContactResolver(app_db)
        names = resolver.resolve_handles(["+15551234567", "user@example.com"])
        # Returns: {"+15551234567": "John Doe", "user@example.com": "Jane Smith"}
    """

    def __init__(self, app_db: AppDb):
        self.app_db = app_db

    def resolve_handles(self, handles: list[str]) -> dict[str, str]:
        """Resolve multiple handles to contact names.

        Args:
            handles: List of phone numbers or email addresses

        Returns:
            Dict mapping handles to contact names. Handles without matches
            are not included in the result.
        """
        return self.app_db.get_names_for_handles(handles)

    def resolve_handle(self, handle: str) -> str | None:
        """Resolve a single handle to a contact name.

        Args:
            handle: Phone number or email address

        Returns:
            Contact name if found, None otherwise
        """
        result = self.resolve_handles([handle])
        return result.get(handle)

    def resolve_sender_names(
        self, messages: list, is_from_me_attr: str = "is_from_me", sender_attr: str = "sender_name"
    ) -> dict[str, str]:
        """Batch resolve sender names for a list of messages.

        Collects all unique sender handles from messages (excluding from_me)
        and resolves them in a single batch query.

        Args:
            messages: List of message objects
            is_from_me_attr: Attribute name for is_from_me flag
            sender_attr: Attribute name for sender identifier

        Returns:
            Dict mapping handles to contact names
        """
        sender_handles = set()
        for msg in messages:
            is_from_me = getattr(msg, is_from_me_attr, False)
            sender = getattr(msg, sender_attr, None)
            if sender and not is_from_me:
                sender_handles.add(sender)

        return self.resolve_handles(list(sender_handles))


def get_chat_display_name(chat, handle_to_name: dict[str, str], handle_ids: list[str]) -> str:
    """Compute display name for a chat.

    For group chats with an explicit display name, uses that.
    For 1:1 chats, uses the resolved contact name or falls back to identifier.

    Args:
        chat: Chat object with is_group, name, and identifier attributes
        handle_to_name: Dict mapping handles to resolved contact names
        handle_ids: List of participant handle identifiers

    Returns:
        Display name for the chat
    """
    # Group with explicit display name (name differs from identifier)
    if chat.is_group and chat.name != chat.identifier:
        return chat.name

    # 1:1 chat or group without display name - use first resolved contact
    if handle_ids:
        return handle_to_name.get(handle_ids[0], handle_ids[0])

    return chat.identifier
