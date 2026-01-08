"""Contacts service - name resolution and contact management."""

from .resolver import ContactResolver, get_chat_display_name

__all__ = ["ContactResolver", "get_chat_display_name"]
