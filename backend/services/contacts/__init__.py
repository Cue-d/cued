"""Contacts service - name resolution and contact management."""

from .handle_lookup import ContactHandleLookup, is_contact
from .resolver import ContactResolver, get_chat_display_name

__all__ = ["ContactResolver", "get_chat_display_name", "ContactHandleLookup", "is_contact"]
