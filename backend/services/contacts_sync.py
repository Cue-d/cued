"""Shared contacts sync service.

Provides a single implementation of contacts sync logic used by both:
- HTTP endpoint (POST /contacts/sync)
- Background job (contacts_sync)

This avoids code duplication and ensures consistent behavior.
"""

import logging
import time
from dataclasses import dataclass

from services.macos.contacts import (
    ContactsAccessDeniedError,
    ContactsError,
    fetch_all_contacts,
    is_swift_contacts_available,
)

logger = logging.getLogger(__name__)


@dataclass
class ContactsSyncResult:
    """Result of a contacts sync operation."""

    success: bool
    message: str
    contacts_added: int = 0
    fetch_time_seconds: float = 0.0
    db_time_seconds: float = 0.0
    total_time_seconds: float = 0.0


def sync_contacts_to_db(app_db) -> ContactsSyncResult:
    """Sync all contacts from Apple Contacts to the database.

    Fetches contacts via Swift CLI and updates the database atomically.

    Args:
        app_db: AppDb instance for prm.db access

    Returns:
        ContactsSyncResult with success status and timing info

    Note:
        Does not raise exceptions - all errors are captured in the result.
        Call is_swift_contacts_available() first if you want to skip
        when the CLI is unavailable.
    """
    start_time = time.time()

    # Check availability first
    if not is_swift_contacts_available():
        binary_path = _get_binary_path_for_logging()
        logger.debug(f"Swift contacts CLI not available at {binary_path}")
        return ContactsSyncResult(
            success=False,
            message=f"Swift contacts CLI not available at {binary_path}",
        )

    try:
        # Fetch contacts via Swift CLI
        contacts = fetch_all_contacts()
        fetch_elapsed = time.time() - start_time

        if not contacts:
            app_db.set_contacts_last_sync(int(time.time()))
            return ContactsSyncResult(
                success=True,
                message="No contacts found in Apple Contacts",
                contacts_added=0,
                fetch_time_seconds=fetch_elapsed,
                total_time_seconds=time.time() - start_time,
            )

        # Sync to database atomically
        db_start = time.time()
        added = 0

        with app_db.transaction() as session:
            app_db.clear_all_contacts_in_transaction(session)

            for contact in contacts:
                app_db.insert_contact_in_transaction(
                    session,
                    name=contact.name,
                    phones=contact.phones,
                    emails=contact.emails,
                    company=contact.company,
                    notes=contact.notes,
                )
                added += 1

        app_db.set_contacts_last_sync(int(time.time()))

        db_elapsed = time.time() - db_start
        total_elapsed = time.time() - start_time

        return ContactsSyncResult(
            success=True,
            message=f"Synced {added} contacts from Apple Contacts",
            contacts_added=added,
            fetch_time_seconds=fetch_elapsed,
            db_time_seconds=db_elapsed,
            total_time_seconds=total_elapsed,
        )

    except ContactsAccessDeniedError:
        return ContactsSyncResult(
            success=False,
            message="Contacts access denied. Grant permission in System Settings.",
            total_time_seconds=time.time() - start_time,
        )

    except ContactsError as e:
        return ContactsSyncResult(
            success=False,
            message=f"Contacts fetch failed: {str(e)}",
            total_time_seconds=time.time() - start_time,
        )

    except Exception as e:
        logger.exception(f"Unexpected error during contacts sync: {e}")
        return ContactsSyncResult(
            success=False,
            message=f"Sync failed: {str(e)}",
            total_time_seconds=time.time() - start_time,
        )


def _get_binary_path_for_logging() -> str:
    """Get the binary path as a string for logging."""
    try:
        from services.macos.contacts import get_contacts_binary_path

        return str(get_contacts_binary_path())
    except Exception:
        return "<unknown>"
