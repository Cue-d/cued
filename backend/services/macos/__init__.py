"""macOS services - iMessage sending and Apple Contacts access."""

from .contacts import (
    ContactsAccessDeniedError,
    ContactsError,
    FetchedContact,
    fetch_all_contacts,
    get_contacts_binary_path,
    is_swift_contacts_available,
)
from .messaging import SendResult, send_message, send_to_group

__all__ = [
    "ContactsAccessDeniedError",
    "ContactsError",
    "FetchedContact",
    "SendResult",
    "fetch_all_contacts",
    "get_contacts_binary_path",
    "is_swift_contacts_available",
    "send_message",
    "send_to_group",
]
