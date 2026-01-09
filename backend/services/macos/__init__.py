"""macOS services - iMessage sending, Apple Contacts access, and notifications."""

from .contacts import (
    ContactsAccessDeniedError,
    ContactsError,
    FetchedContact,
    fetch_all_contacts,
    get_contacts_binary_path,
    is_swift_contacts_available,
)
from .messaging import SendResult, send_message, send_to_group
from .notifications import (
    cancel_scheduled_notification,
    get_scheduled_notification_count,
    notify_new_action,
    schedule_action_notification,
    send_notification,
)

__all__ = [
    "ContactsAccessDeniedError",
    "ContactsError",
    "FetchedContact",
    "SendResult",
    "cancel_scheduled_notification",
    "fetch_all_contacts",
    "get_contacts_binary_path",
    "get_scheduled_notification_count",
    "is_swift_contacts_available",
    "notify_new_action",
    "schedule_action_notification",
    "send_message",
    "send_notification",
    "send_to_group",
]
