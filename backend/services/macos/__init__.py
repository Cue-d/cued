"""macOS services - iMessage sending and Apple Contacts access."""

from .contacts import FetchedContact, fetch_all_contact_names, fetch_contacts_by_names
from .messaging import SendResult, send_message, send_to_group

__all__ = [
    "SendResult",
    "send_message",
    "send_to_group",
    "FetchedContact",
    "fetch_all_contact_names",
    "fetch_contacts_by_names",
]
