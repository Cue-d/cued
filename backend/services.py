import json
import os

import core


def strip_country_code(phone: str) -> str:
    """Strip leading country code (1 for US) from normalized phone number."""
    if len(phone) == 11 and phone.startswith("1"):
        return phone[1:]
    return phone


class HandleResolver:
    """Resolves handles (phone/email) to contact names."""

    def __init__(self, app_db_path: str):
        self._lookup: dict[str, str] = {}
        self._build_lookup(app_db_path)

    def _build_lookup(self, app_db_path: str):
        """Build a normalized phone/email -> contact name lookup."""
        if not os.path.exists(app_db_path):
            return

        db = core.AppDb(app_db_path)
        contacts = db.get_all_contacts()

        for contact in contacts:
            # Parse phones JSON array
            if contact.phones:
                try:
                    phones = json.loads(contact.phones)
                    for phone in phones:
                        normalized = core.normalize_phone(phone)
                        if normalized:
                            # Store both with and without country code
                            self._lookup[normalized] = contact.name
                            stripped = strip_country_code(normalized)
                            if stripped != normalized:
                                self._lookup[stripped] = contact.name
                except json.JSONDecodeError:
                    pass

            # Parse emails JSON array
            if contact.emails:
                try:
                    emails = json.loads(contact.emails)
                    for email in emails:
                        normalized = core.normalize_email(email)
                        if normalized:
                            self._lookup[normalized] = contact.name
                except json.JSONDecodeError:
                    pass

    def resolve(self, handle_id: str) -> str | None:
        """Resolve a handle ID to a contact name."""
        # Try as phone number
        normalized_phone = core.normalize_phone(handle_id)
        if normalized_phone in self._lookup:
            return self._lookup[normalized_phone]

        # Try without country code
        stripped = strip_country_code(normalized_phone)
        if stripped in self._lookup:
            return self._lookup[stripped]

        # Try as email
        normalized_email = core.normalize_email(handle_id)
        if normalized_email in self._lookup:
            return self._lookup[normalized_email]

        return None
