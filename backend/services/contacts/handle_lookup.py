"""Contact handle lookup service.

Provides fast O(1) lookup to check if a phone number or email belongs to
a saved contact in Apple Contacts.
"""

import logging
import time

from services.macos.contacts import fetch_all_contacts
from utils.phone import get_phone_variants

logger = logging.getLogger(__name__)

# Refresh interval in seconds (5 minutes)
REFRESH_INTERVAL = 300


def normalize_email(email: str) -> str:
    """Normalize email for comparison.

    Lowercases and strips whitespace.
    """
    return email.lower().strip()


class ContactHandleLookup:
    """In-memory cache of contact phone/email handles.

    Singleton that caches all phone numbers and emails from Apple Contacts
    for fast O(1) lookup. Auto-refreshes every 5 minutes.

    Usage:
        lookup = ContactHandleLookup.get_instance()
        if lookup.is_contact("+1-555-123-4567"):
            print("This is a known contact")
    """

    _instance: "ContactHandleLookup | None" = None
    _handles: set[str]
    _last_refresh: float

    def __init__(self) -> None:
        self._handles = set()
        self._last_refresh = 0.0

    @classmethod
    def get_instance(cls) -> "ContactHandleLookup":
        """Get the singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def refresh(self, force: bool = False) -> None:
        """Refresh the contact handles cache.

        Args:
            force: If True, refresh even if cache is fresh
        """
        now = time.time()
        if not force and (now - self._last_refresh) < REFRESH_INTERVAL:
            return  # Cache is still fresh

        try:
            contacts = fetch_all_contacts()
            handles: set[str] = set()

            for contact in contacts:
                for phone in contact.phones:
                    # Store all variants for robust matching
                    for variant in get_phone_variants(phone):
                        handles.add(variant)

                for email in contact.emails:
                    normalized = normalize_email(email)
                    if normalized:
                        handles.add(normalized)

            self._handles = handles
            self._last_refresh = now
            logger.info(
                f"[contact_lookup] Refreshed {len(handles)} handles from {len(contacts)} contacts"
            )

        except Exception as e:
            logger.error(f"[contact_lookup] Failed to refresh contacts: {e}")
            # Keep existing cache on error

    def is_contact(self, identifier: str | None) -> bool:
        """Check if an identifier belongs to a saved contact.

        Args:
            identifier: Phone number or email address

        Returns:
            True if the identifier belongs to a saved contact
        """
        if not identifier:
            return False

        # Ensure cache is fresh
        self.refresh()

        # Email check
        if "@" in identifier:
            return normalize_email(identifier) in self._handles

        # Phone check - try all variants (handles +1 prefix differences)
        for variant in get_phone_variants(identifier):
            if variant in self._handles:
                return True

        return False

    def get_handle_count(self) -> int:
        """Get the number of cached handles."""
        return len(self._handles)


# Convenience function for simple usage
def is_contact(identifier: str | None) -> bool:
    """Check if an identifier belongs to a saved contact.

    This is a convenience wrapper around ContactHandleLookup.

    Args:
        identifier: Phone number or email address

    Returns:
        True if the identifier belongs to a saved contact
    """
    return ContactHandleLookup.get_instance().is_contact(identifier)
