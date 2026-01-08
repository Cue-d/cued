"""
Apple Contacts sync engine.

Provides incremental syncing of Apple Contacts to prm.db using modification
timestamps. The sync engine:

1. Fetches all contacts on first sync (full sync)
2. Uses modification_date for incremental syncs
3. Detects deleted contacts by comparing Apple Contact IDs
4. Updates the people table with fresh contact data

Architecture:
    Apple Contacts → contacts table (prm.db) → people table (via ContactLookup)
"""

import json
import logging
import time

import core

logger = logging.getLogger(__name__)


class ContactSyncResult:
    """Result of a contact sync operation."""

    def __init__(
        self,
        synced: int = 0,
        created: int = 0,
        updated: int = 0,
        deleted: int = 0,
        duration_seconds: float = 0.0,
        is_full_sync: bool = False,
    ):
        self.synced = synced
        self.created = created
        self.updated = updated
        self.deleted = deleted
        self.duration_seconds = duration_seconds
        self.is_full_sync = is_full_sync

    def __repr__(self):
        return (
            f"ContactSyncResult(synced={self.synced}, created={self.created}, "
            f"updated={self.updated}, deleted={self.deleted}, "
            f"duration={self.duration_seconds:.2f}s, full_sync={self.is_full_sync})"
        )

    def to_dict(self):
        return {
            "synced": self.synced,
            "created": self.created,
            "updated": self.updated,
            "deleted": self.deleted,
            "duration_seconds": round(self.duration_seconds, 2),
            "is_full_sync": self.is_full_sync,
        }


class ContactSyncStatus:
    """Current status of the contact sync engine."""

    def __init__(
        self,
        total_contacts: int = 0,
        deleted_contacts: int = 0,
        last_sync_timestamp: int = 0,
        last_modification_timestamp: int = 0,
    ):
        self.total_contacts = total_contacts
        self.deleted_contacts = deleted_contacts
        self.last_sync_timestamp = last_sync_timestamp
        self.last_modification_timestamp = last_modification_timestamp

    def to_dict(self):
        return {
            "total_contacts": self.total_contacts,
            "deleted_contacts": self.deleted_contacts,
            "last_sync_timestamp": self.last_sync_timestamp,
            "last_modification_timestamp": self.last_modification_timestamp,
        }


def get_sync_status(app_db: core.AppDb) -> ContactSyncStatus:
    """Get the current contact sync status."""
    active, deleted = app_db.get_contact_stats()
    last_sync = app_db.get_sync_state("last_contacts_sync")
    last_modification = app_db.get_latest_contact_modification()

    return ContactSyncStatus(
        total_contacts=active,
        deleted_contacts=deleted,
        last_sync_timestamp=last_sync,
        last_modification_timestamp=last_modification,
    )


def sync_contacts_full(app_db: core.AppDb, verbose: bool = False) -> ContactSyncResult:
    """
    Perform a full sync of all Apple Contacts.

    This fetches all contacts from Apple Contacts and upserts them into prm.db.
    Use this for initial sync or when you want to force a complete refresh.
    """
    start = time.time()
    logger.info("Starting FULL contacts sync")

    if verbose:
        print("    Fetching all contacts from Apple Contacts...")

    # Fetch all contacts with their metadata
    logger.debug("Fetching all contacts from Apple Contacts via AppleScript...")
    contacts = core.fetch_all_contacts_for_sync()
    total = len(contacts)
    logger.info(f"Fetched {total} contacts from Apple Contacts")

    if verbose:
        print(f"    Found {total} contacts, syncing to database...")

    # Get existing contact IDs for tracking creates vs updates
    existing_ids = set(app_db.get_all_contact_apple_ids())

    created = 0
    updated = 0

    for i, contact in enumerate(contacts):
        phones_json = json.dumps(contact.phones) if contact.phones else None
        emails_json = json.dumps(contact.emails) if contact.emails else None

        app_db.upsert_contact(
            apple_id=contact.apple_id,
            name=contact.name,
            phones=phones_json,
            emails=emails_json,
            company=contact.company,
            notes=contact.notes,
            apple_created_at=contact.apple_created_at,
            apple_modified_at=contact.apple_modified_at,
        )

        if contact.apple_id in existing_ids:
            updated += 1
        else:
            created += 1

        if verbose and (i + 1) % 100 == 0:
            print(f"    Progress: {i + 1}/{total} contacts...")

    # Detect deleted contacts
    current_apple_ids = {c.apple_id for c in contacts}
    deleted_ids = existing_ids - current_apple_ids

    deleted = 0
    if deleted_ids:
        deleted = app_db.mark_contacts_deleted(list(deleted_ids))
        if verbose:
            print(f"    Marked {deleted} contacts as deleted")

    # Update sync timestamp
    now = int(time.time())
    app_db.set_sync_state("last_contacts_sync", now)

    duration = time.time() - start

    logger.info(
        f"Full sync completed: {created} created, {updated} updated, "
        f"{deleted} deleted in {duration:.2f}s"
    )

    if verbose:
        print(f"    Full sync completed in {duration:.2f}s")
        print(f"    Created: {created}, Updated: {updated}, Deleted: {deleted}")

    return ContactSyncResult(
        synced=total,
        created=created,
        updated=updated,
        deleted=deleted,
        duration_seconds=duration,
        is_full_sync=True,
    )


def sync_contacts_incremental(app_db: core.AppDb, verbose: bool = False) -> ContactSyncResult:
    """
    Perform an incremental sync of Apple Contacts.

    This only fetches contacts modified since the last sync, which is much
    faster than a full sync for large contact lists.
    """
    start = time.time()
    logger.info("Starting INCREMENTAL contacts sync")

    # Get the last modification timestamp from our database
    last_modification = app_db.get_latest_contact_modification()
    logger.debug(f"Last modification timestamp in DB: {last_modification}")

    if last_modification == 0:
        # No contacts synced yet, do a full sync
        logger.info("No existing contacts, falling back to full sync")
        if verbose:
            print("    No existing contacts, performing full sync...")
        return sync_contacts_full(app_db, verbose)

    if verbose:
        print(f"    Fetching contacts modified since timestamp {last_modification}...")

    # Fetch only modified contacts
    logger.debug(f"Fetching contacts modified since {last_modification}...")
    modified_contacts = core.fetch_contacts_modified_since(last_modification)
    logger.info(f"Found {len(modified_contacts)} modified contacts")

    if verbose:
        print(f"    Found {len(modified_contacts)} modified contacts")

    # Get existing contact IDs for tracking creates vs updates
    existing_ids = set(app_db.get_all_contact_apple_ids())

    created = 0
    updated = 0

    for contact in modified_contacts:
        phones_json = json.dumps(contact.phones) if contact.phones else None
        emails_json = json.dumps(contact.emails) if contact.emails else None

        app_db.upsert_contact(
            apple_id=contact.apple_id,
            name=contact.name,
            phones=phones_json,
            emails=emails_json,
            company=contact.company,
            notes=contact.notes,
            apple_created_at=contact.apple_created_at,
            apple_modified_at=contact.apple_modified_at,
        )

        if contact.apple_id in existing_ids:
            updated += 1
        else:
            created += 1

    # Check for deleted contacts
    # This requires fetching all current Apple Contact IDs
    if verbose:
        print("    Checking for deleted contacts...")

    current_apple_ids = set(core.fetch_all_contact_ids())
    deleted_ids = existing_ids - current_apple_ids

    deleted = 0
    if deleted_ids:
        deleted = app_db.mark_contacts_deleted(list(deleted_ids))
        if verbose:
            print(f"    Marked {deleted} contacts as deleted")

    # Update sync timestamp
    now = int(time.time())
    app_db.set_sync_state("last_contacts_sync", now)

    duration = time.time() - start

    logger.info(
        f"Incremental sync completed: {created} created, {updated} updated, "
        f"{deleted} deleted in {duration:.2f}s"
    )

    if verbose:
        print(f"    Incremental sync completed in {duration:.2f}s")
        print(f"    Created: {created}, Updated: {updated}, Deleted: {deleted}")

    return ContactSyncResult(
        synced=len(modified_contacts),
        created=created,
        updated=updated,
        deleted=deleted,
        duration_seconds=duration,
        is_full_sync=False,
    )


def sync_contacts(
    app_db: core.AppDb, force_full: bool = False, verbose: bool = False
) -> ContactSyncResult:
    """
    Sync contacts from Apple Contacts to prm.db.

    Args:
        app_db: The app database connection
        force_full: If True, perform a full sync even if incremental is possible
        verbose: If True, print progress information

    Returns:
        ContactSyncResult with sync statistics
    """
    # Check if we have any contacts - if not, do a full sync
    active, deleted = app_db.get_contact_stats()
    logger.debug(f"Contact stats: {active} active, {deleted} deleted")

    if force_full:
        logger.info("Force full sync requested")
        return sync_contacts_full(app_db, verbose)

    if active == 0:
        logger.info("No active contacts found, performing full sync")
        return sync_contacts_full(app_db, verbose)

    # Check if we have a last modification timestamp - if not, do a full sync
    last_modification = app_db.get_latest_contact_modification()
    if last_modification == 0:
        logger.info("No last modification timestamp found, performing full sync")
        return sync_contacts_full(app_db, verbose)

    # We have contacts and a timestamp, do incremental sync
    logger.info(f"Performing incremental sync (last modification: {last_modification})")
    return sync_contacts_incremental(app_db, verbose)


class SyncedContactLookup:
    """
    Lookup from phone/email to contact info using the synced contacts table.

    This is similar to ContactLookup in sync_db.py but uses the contacts table
    instead of fetching from Apple Contacts each time.
    """

    def __init__(self, app_db: core.AppDb):
        self._name_lookup: dict[str, str] = {}
        self._contact_lookup: dict[str, core.SyncedContact] = {}
        self._contact_id_lookup: dict[str, int] = {}  # normalized identifier -> contact.id
        self._build_lookup(app_db)

    def _build_lookup(self, app_db: core.AppDb):
        """Build normalized phone/email -> contact lookup from database."""
        contacts = app_db.get_all_contacts()

        phone_count = 0
        email_count = 0
        sample_phones = []

        for contact in contacts:
            # Index by phones
            for phone in contact.phones:
                normalized = core.normalize_phone(phone)
                if normalized:
                    self._name_lookup[normalized] = contact.name
                    self._contact_lookup[normalized] = contact
                    self._contact_id_lookup[normalized] = contact.id
                    phone_count += 1
                    if len(sample_phones) < 5:
                        sample_phones.append(f"{phone} -> {normalized}")
                    # Also store without country code (US)
                    stripped = self._strip_country_code(normalized)
                    if stripped != normalized:
                        self._name_lookup[stripped] = contact.name
                        self._contact_lookup[stripped] = contact
                        self._contact_id_lookup[stripped] = contact.id

            # Index by emails
            for email in contact.emails:
                normalized = core.normalize_email(email)
                if normalized:
                    self._name_lookup[normalized] = contact.name
                    self._contact_lookup[normalized] = contact
                    self._contact_id_lookup[normalized] = contact.id
                    email_count += 1

        logger.debug(f"Built lookup from {len(contacts)} contacts")
        logger.debug(f"Indexed {phone_count} phones, {email_count} emails")
        if sample_phones:
            logger.debug(f"Sample normalized phones: {sample_phones}")

    def _strip_country_code(self, phone: str) -> str:
        """Strip leading country code (1 for US) from normalized phone number."""
        if len(phone) == 11 and phone.startswith("1"):
            return phone[1:]
        return phone

    def get_name(self, identifier: str) -> str | None:
        """Get contact name for identifier, or None if not found."""
        # Try as phone
        normalized = core.normalize_phone(identifier)
        if normalized in self._name_lookup:
            return self._name_lookup[normalized]
        stripped = self._strip_country_code(normalized)
        if stripped in self._name_lookup:
            return self._name_lookup[stripped]

        # Try as email
        normalized = core.normalize_email(identifier)
        if normalized in self._name_lookup:
            return self._name_lookup[normalized]

        return None

    def get_contact(self, identifier: str) -> core.SyncedContact | None:
        """Get full contact for identifier, or None if not found."""
        normalized = core.normalize_phone(identifier)
        if normalized in self._contact_lookup:
            return self._contact_lookup[normalized]
        stripped = self._strip_country_code(normalized)
        if stripped in self._contact_lookup:
            return self._contact_lookup[stripped]

        normalized = core.normalize_email(identifier)
        if normalized in self._contact_lookup:
            return self._contact_lookup[normalized]

        return None

    def get_contact_id(self, identifier: str) -> int | None:
        """Get contact database ID for identifier, or None if not found."""
        normalized = core.normalize_phone(identifier)
        if normalized in self._contact_id_lookup:
            return self._contact_id_lookup[normalized]
        stripped = self._strip_country_code(normalized)
        if stripped in self._contact_id_lookup:
            return self._contact_id_lookup[stripped]

        normalized = core.normalize_email(identifier)
        if normalized in self._contact_id_lookup:
            return self._contact_id_lookup[normalized]

        return None

    @property
    def contact_count(self) -> int:
        """Get the number of unique contacts in the lookup."""
        return len({c.apple_id for c in self._contact_lookup.values()})
