"""
Sync data from chat.db to prm.db.

This is the main sync job that copies iMessage data (handles, chats, messages,
attachments) from the read-only chat.db to our prm.db. Names are resolved at
sync time by merging with Apple Contacts data.

Architecture:
    chat.db (read-only) -> sync_db.py -> prm.db (source of truth)

    For contacts:
    Apple Contacts -> contact_sync.py -> contacts table
                                      -> people table (via SyncedContactLookup)
"""

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import core

from contact_sync import SyncedContactLookup, sync_contacts

logger = logging.getLogger(__name__)

# Config
CHAT_DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")
CONTACTS_CACHE_PATH = os.path.expanduser("~/.prm/contacts_cache.json")
MESSAGE_BATCH_SIZE = 1000
ATTACHMENT_BATCH_SIZE = 1000
CONTACTS_CACHE_TTL = 3600  # 1 hour


def load_contacts_cache(verbose: bool = False) -> list | None:
    """Load contacts from cache if fresh enough."""
    if not os.path.exists(CONTACTS_CACHE_PATH):
        return None
    try:
        with open(CONTACTS_CACHE_PATH) as f:
            data = json.load(f)
        # Check TTL
        cached_at = data.get("cached_at", 0)
        if time.time() - cached_at > CONTACTS_CACHE_TTL:
            if verbose:
                print("    Contacts cache expired, refetching...")
            return None
        contacts_data = data.get("contacts", [])
        if verbose:
            print(f"    Loaded {len(contacts_data)} contacts from cache")
        return contacts_data
    except Exception as e:
        if verbose:
            print(f"    Could not load contacts cache: {e}")
        return None


def save_contacts_cache(contacts: list, verbose: bool = False):
    """Save contacts to cache."""
    try:
        contacts_data = [
            {
                "name": c.name,
                "emails": c.emails,
                "phones": c.phones,
                "company": c.company,
                "notes": c.notes,
            }
            for c in contacts
        ]
        with open(CONTACTS_CACHE_PATH, "w") as f:
            json.dump({"cached_at": time.time(), "contacts": contacts_data}, f)
        if verbose:
            print(f"    Saved {len(contacts)} contacts to cache")
    except Exception as e:
        if verbose:
            print(f"    Could not save contacts cache: {e}")


class CachedContact:
    """Simple contact object reconstructed from cache."""

    def __init__(self, data: dict):
        self.name = data["name"]
        self.emails = data.get("emails", [])
        self.phones = data.get("phones", [])
        self.company = data.get("company")
        self.notes = data.get("notes")


def strip_country_code(phone: str) -> str:
    """Strip leading country code (1 for US) from normalized phone number."""
    if len(phone) == 11 and phone.startswith("1"):
        return phone[1:]
    return phone


def fallback_name(identifier: str) -> str:
    """Generate a fallback name for an unmatched handle."""
    # For phone numbers, show last 4 digits
    normalized = core.normalize_phone(identifier)
    if normalized and len(normalized) >= 4:
        return f"...{normalized[-4:]}"

    # For emails, show the whole thing
    return identifier


class ContactLookup:
    """Lookup from phone/email to contact info."""

    def __init__(self, contacts: list):
        self._name_lookup: dict[str, str] = {}
        self._contact_lookup: dict[str, object] = {}
        self._build_lookup(contacts)

    def _build_lookup(self, contacts: list):
        """Build normalized phone/email -> contact lookup."""
        for contact in contacts:
            # Store the full contact
            for phone in contact.phones:
                normalized = core.normalize_phone(phone)
                if normalized:
                    self._name_lookup[normalized] = contact.name
                    self._contact_lookup[normalized] = contact
                    # Also store without country code
                    stripped = strip_country_code(normalized)
                    if stripped != normalized:
                        self._name_lookup[stripped] = contact.name
                        self._contact_lookup[stripped] = contact

            for email in contact.emails:
                normalized = core.normalize_email(email)
                if normalized:
                    self._name_lookup[normalized] = contact.name
                    self._contact_lookup[normalized] = contact

    def get_name(self, identifier: str) -> str | None:
        """Get contact name for identifier, or None if not found."""
        # Try as phone
        normalized = core.normalize_phone(identifier)
        if normalized in self._name_lookup:
            return self._name_lookup[normalized]
        stripped = strip_country_code(normalized)
        if stripped in self._name_lookup:
            return self._name_lookup[stripped]

        # Try as email
        normalized = core.normalize_email(identifier)
        if normalized in self._name_lookup:
            return self._name_lookup[normalized]

        return None

    def get_contact(self, identifier: str) -> object | None:
        """Get full contact for identifier, or None if not found."""
        normalized = core.normalize_phone(identifier)
        if normalized in self._contact_lookup:
            return self._contact_lookup[normalized]
        stripped = strip_country_code(normalized)
        if stripped in self._contact_lookup:
            return self._contact_lookup[stripped]

        normalized = core.normalize_email(identifier)
        if normalized in self._contact_lookup:
            return self._contact_lookup[normalized]

        return None

    def get_contact_id(self, identifier: str) -> None:
        """Legacy lookup doesn't track contact IDs - always returns None."""
        return None


PEOPLE_BATCH_SIZE = 100  # Number of people to upsert in a single transaction


def sync_people(
    app_db: core.AppDb,
    chat_reader: core.ChatReader,
    contact_lookup: "ContactLookup | SyncedContactLookup",
    verbose: bool = False,
) -> int:
    """
    Sync handles from chat.db as people in prm.db, resolving names from contacts.

    Uses batch upserts for better performance (wraps multiple inserts in a single
    transaction instead of one transaction per insert).

    Returns the number of people synced.
    """
    handles = chat_reader.get_all_handles_for_sync()
    total = len(handles)
    synced = 0
    matched = 0
    unmatched_samples = []

    # Collect people data for batch upsert
    batch = []

    for handle in handles:
        contact = contact_lookup.get_contact(handle.identifier)

        if contact:
            # Found matching contact - use contact name
            name = contact.name
            is_contact = True
            contact_id = contact_lookup.get_contact_id(handle.identifier)
            phones = json.dumps(contact.phones) if contact.phones else None
            emails = json.dumps(contact.emails) if contact.emails else None
            company = contact.company
            notes = contact.notes
            matched += 1
        else:
            # No contact - use fallback name
            name = fallback_name(handle.identifier)
            is_contact = False
            contact_id = None
            phones = None
            emails = None
            company = None
            notes = None
            # Collect sample of unmatched handles for debugging
            if len(unmatched_samples) < 10:
                normalized = core.normalize_phone(handle.identifier)
                unmatched_samples.append(f"{handle.identifier} -> {normalized}")

        # Add to batch as tuple:
        # (id, identifier, name, service, is_contact, contact_id, phones, emails, company, notes)
        batch.append(
            (
                handle.id,
                handle.identifier,
                name,
                handle.service,
                is_contact,
                contact_id,
                phones,
                emails,
                company,
                notes,
            )
        )

        # Flush batch when it reaches the batch size
        if len(batch) >= PEOPLE_BATCH_SIZE:
            app_db.upsert_people_batch(batch)
            synced += len(batch)
            batch = []

            # Progress output every batch
            if verbose:
                print(f"    Progress: {synced}/{total} people synced...")

    # Flush remaining batch
    if batch:
        app_db.upsert_people_batch(batch)
        synced += len(batch)

    # Debug logging for contact matching
    if verbose:
        print(f"    [DEBUG] Matched {matched}/{total} handles to contacts")
        if unmatched_samples:
            print(f"    [DEBUG] Sample unmatched handles: {unmatched_samples[:5]}")

    return synced


def sync_chats(
    app_db: core.AppDb,
    chat_reader: core.ChatReader,
    contact_lookup: "ContactLookup | SyncedContactLookup",
    verbose: bool = False,
) -> int:
    """
    Sync chats from chat.db to prm.db with pre-computed display names.

    Returns the number of chats synced.
    """
    # TODO: Pre-compute a handle_id -> resolved_name map before iterating chats.
    # Currently, for each chat we look up participant names via contact_lookup.get_name(),
    # which repeats normalization work. Building a dict[handle_id, str] upfront would
    # eliminate redundant lookups and speed up group chat name computation.
    chats = chat_reader.get_all_chats_for_sync()
    participants = chat_reader.get_chat_participants_for_sync()
    total = len(chats)

    if verbose:
        print(f"    Found {total} chats, {len(participants)} participant links...")

    # Build chat_id -> list of handle_ids mapping
    chat_to_handles: dict[int, list[int]] = {}
    for chat_id, handle_id in participants:
        if chat_id not in chat_to_handles:
            chat_to_handles[chat_id] = []
        chat_to_handles[chat_id].append(handle_id)

    # Get all handles for name lookup
    handles = chat_reader.get_all_handles_for_sync()
    handle_map: dict[int, object] = {h.id: h for h in handles}

    synced = 0
    for chat in chats:
        # Compute display name at sync time
        # If user set a name (display_name from chat.db), use it; otherwise compute
        if chat.display_name:
            name = chat.display_name
        elif chat.is_group:
            # Group chat - join participant first names (e.g., "Soham, Aaron, Jay")
            handle_ids = chat_to_handles.get(chat.id, [])
            participant_names = []
            for hid in handle_ids:
                handle = handle_map.get(hid)
                if handle:
                    contact_name = contact_lookup.get_name(handle.identifier)
                    if contact_name:
                        # Use first name for compact group display
                        first_name = contact_name.split()[0]
                        participant_names.append(first_name)
                    else:
                        participant_names.append(fallback_name(handle.identifier))
            if len(participant_names) > 4:
                name = ", ".join(participant_names[:4]) + f" +{len(participant_names) - 4}"
            elif participant_names:
                name = ", ".join(participant_names)
            else:
                name = chat.identifier
        else:
            # 1:1 chat - use the other person's name
            handle_ids = chat_to_handles.get(chat.id, [])
            if handle_ids:
                handle = handle_map.get(handle_ids[0])
                if handle:
                    contact_name = contact_lookup.get_name(handle.identifier)
                    name = contact_name or fallback_name(handle.identifier)
                else:
                    name = chat.identifier
            else:
                name = chat.identifier

        app_db.upsert_chat(chat, name)
        synced += 1

        # Progress output every 100 chats
        if verbose and synced % 100 == 0:
            print(f"    Progress: {synced}/{total} chats synced...")

    # Sync chat participants (filter to known chats and handles/people)
    known_chat_ids = {c.id for c in chats}
    known_person_ids = {h.id for h in handles}
    valid_participants = [
        (c, p) for c, p in participants if c in known_chat_ids and p in known_person_ids
    ]
    if verbose:
        n = len(valid_participants)
        print(f"    Syncing {n} chat participant links (from {len(participants)})...")
    app_db.replace_chat_participants(valid_participants)

    return synced


def sync_messages(
    app_db: core.AppDb,
    chat_reader: core.ChatReader,
    verbose: bool = False,
) -> int:
    """
    Incrementally sync messages from chat.db to prm.db.

    Returns the number of messages synced.
    """
    last_rowid = app_db.get_sync_state("last_message_rowid")
    total_synced = 0
    batch_num = 0

    if verbose:
        print(f"    Starting from message ROWID {last_rowid}...")

    while True:
        messages = chat_reader.get_messages_since(last_rowid, MESSAGE_BATCH_SIZE)
        if not messages:
            break

        app_db.insert_messages(messages)
        total_synced += len(messages)
        last_rowid = max(m.id for m in messages)
        app_db.set_sync_state("last_message_rowid", last_rowid)
        batch_num += 1

        if verbose:
            print(f"    Batch {batch_num}: synced {len(messages)} messages (total: {total_synced})")

    return total_synced


def sync_attachments(
    app_db: core.AppDb,
    chat_reader: core.ChatReader,
    verbose: bool = False,
) -> int:
    """
    Incrementally sync attachments from chat.db to prm.db.

    Returns the number of attachments synced.
    """
    last_rowid = app_db.get_sync_state("last_attachment_rowid")
    total_synced = 0
    batch_num = 0

    if verbose:
        print(f"    Starting from attachment ROWID {last_rowid}...")

    while True:
        attachments = chat_reader.get_attachments_since(last_rowid, ATTACHMENT_BATCH_SIZE)
        if not attachments:
            break

        app_db.insert_attachments(attachments)
        total_synced += len(attachments)
        last_rowid = max(a.id for a in attachments)
        app_db.set_sync_state("last_attachment_rowid", last_rowid)
        batch_num += 1

        if verbose:
            n = len(attachments)
            print(f"    Batch {batch_num}: synced {n} attachments (total: {total_synced})")

    return total_synced


def sync_all(verbose: bool = True, use_new_contacts_sync: bool = True):
    """
    Full sync from chat.db to prm.db.

    This syncs:
    1. Contacts (Apple Contacts -> contacts table, incremental)
    2. People (handles merged with contacts)
    3. Chats (with pre-computed display names)
    4. Chat participants
    5. Messages (incremental)
    6. Attachments (incremental)

    Args:
        verbose: If True, print progress information
        use_new_contacts_sync: If True, use the new incremental contacts sync engine.
                               If False, use the legacy caching approach.
    """
    start_total = time.time()

    if verbose:
        print("=" * 50)
        print("Starting sync from chat.db to prm.db")
        print("=" * 50)

    # Ensure directory exists
    os.makedirs(os.path.dirname(APP_DB_PATH), exist_ok=True)

    # Open databases
    if verbose:
        print("\nOpening databases...")
    app_db = core.AppDb(APP_DB_PATH)
    app_db.init_schema()

    if not os.path.exists(CHAT_DB_PATH):
        if verbose:
            print(f"ERROR: chat.db not found at {CHAT_DB_PATH}")
        return

    chat_reader = core.ChatReader(CHAT_DB_PATH)
    if verbose:
        print("  Databases opened successfully")

    # Sync contacts using the new incremental sync engine
    if use_new_contacts_sync:
        if verbose:
            print("\n[1/6] Syncing contacts (Apple Contacts -> contacts table)...")
        start = time.time()
        try:
            result = sync_contacts(app_db, verbose=verbose)
            logger.info(
                f"Contacts sync completed: {result.synced} contacts "
                f"({result.created} created, {result.updated} updated, {result.deleted} deleted)"
            )
            if verbose:
                sync_type = "full" if result.is_full_sync else "incremental"
                print(f"    Completed {sync_type} sync: {result.synced} contacts")
                print(
                    f"    Created: {result.created}, Updated: {result.updated}, "
                    f"Deleted: {result.deleted}"
                )
                print(f"    Duration: {time.time() - start:.1f}s")
        except Exception as e:
            logger.warning(f"Contacts sync failed: {e}, falling back to legacy")
            if verbose:
                print(f"    WARNING: Contacts sync failed: {e}")
                print("    Falling back to legacy contact loading...")
            use_new_contacts_sync = False

    # Build contact lookup for name resolution
    if use_new_contacts_sync:
        if verbose:
            print("\n[2/6] Building contact lookup from synced contacts...")
        start = time.time()
        try:
            contact_lookup = SyncedContactLookup(app_db)
            logger.info(f"Contact lookup built with {contact_lookup.contact_count} contacts")
            if verbose:
                count = contact_lookup.contact_count
                print(f"    Loaded {count} contacts in {time.time() - start:.1f}s")
        except Exception as e:
            logger.warning(f"Failed to build contact lookup: {e}, falling back to legacy")
            if verbose:
                print(f"    WARNING: Failed to build lookup: {e}")
                print("    Falling back to legacy contact loading...")
            use_new_contacts_sync = False

    # Legacy contact loading (fallback)
    if not use_new_contacts_sync:
        if verbose:
            print("\n[1/5] Fetching contacts for name resolution (legacy)...")
        start = time.time()
        contacts = []

        # Try cache first
        cached_contacts = load_contacts_cache(verbose)
        if cached_contacts is not None:
            contacts = [CachedContact(c) for c in cached_contacts]
        else:
            # Fetch from Apple Contacts
            try:
                names = core.fetch_all_contact_names()
                total_names = len(names)
                if verbose:
                    print(f"    Found {total_names} contact names, fetching details...")

                # Fetch contacts in parallel batches (10 batches of 10 at a time)
                batch_size = 10
                parallel_batches = 10
                batches = [names[i : i + batch_size] for i in range(0, total_names, batch_size)]
                total_batches = len(batches)
                completed = 0

                def fetch_batch(batch_names):
                    return core.fetch_contacts_by_names(batch_names)

                if verbose:
                    print(
                        f"    Processing {total_batches} batches ({parallel_batches} parallel)..."
                    )

                # Process batches in parallel chunks
                for chunk_start in range(0, total_batches, parallel_batches):
                    chunk = batches[chunk_start : chunk_start + parallel_batches]
                    with ThreadPoolExecutor(max_workers=parallel_batches) as executor:
                        futures = {executor.submit(fetch_batch, batch): batch for batch in chunk}
                        for future in as_completed(futures):
                            try:
                                batch_contacts = future.result()
                                contacts.extend(batch_contacts)
                                completed += 1
                                if verbose:
                                    print(f"    Progress: {completed}/{total_batches} batches...")
                            except Exception as e:
                                if verbose:
                                    print(f"    Batch error: {e}", flush=True)

                # Cache the results
                save_contacts_cache(contacts, verbose)
            except Exception as e:
                if verbose:
                    print(f"    WARNING: Could not fetch contacts: {e}")
                contacts = []

        contact_lookup = ContactLookup(contacts)
        if verbose:
            print(f"    Loaded {len(contacts)} contacts in {time.time() - start:.1f}s")

    # Sync people (handles + contacts)
    step = 3 if use_new_contacts_sync else 2
    total_steps = 6 if use_new_contacts_sync else 5
    if verbose:
        print(f"\n[{step}/{total_steps}] Syncing people (handles + contacts)...")
    start = time.time()
    people_synced = sync_people(app_db, chat_reader, contact_lookup, verbose)
    logger.info(f"People sync completed: {people_synced} people")
    if verbose:
        print(f"    Completed: {people_synced} people in {time.time() - start:.1f}s")

    # Sync chats
    step += 1
    if verbose:
        print(f"\n[{step}/{total_steps}] Syncing chats...")
    start = time.time()
    chats_synced = sync_chats(app_db, chat_reader, contact_lookup, verbose)
    logger.info(f"Chats sync completed: {chats_synced} chats")
    if verbose:
        print(f"    Completed: {chats_synced} chats in {time.time() - start:.1f}s")

    # Sync messages (incremental)
    # TODO: Run message and attachment syncs in parallel using ThreadPoolExecutor.
    # They are independent after the initial message sync completes - messages don't
    # depend on attachments, and attachments only need message IDs to exist (which
    # they will after the first message batch). Could use concurrent.futures to
    # run both sync loops simultaneously, potentially halving this phase's time.
    step += 1
    if verbose:
        print(f"\n[{step}/{total_steps}] Syncing messages (incremental)...")
    start = time.time()
    messages_synced = sync_messages(app_db, chat_reader, verbose)
    if verbose:
        print(f"    Completed: {messages_synced} new messages in {time.time() - start:.1f}s")

    # Sync attachments (incremental)
    step += 1
    if verbose:
        print(f"\n[{step}/{total_steps}] Syncing attachments (incremental)...")
    start = time.time()
    attachments_synced = sync_attachments(app_db, chat_reader, verbose)
    if verbose:
        print(f"    Completed: {attachments_synced} new attachments in {time.time() - start:.1f}s")

    if verbose:
        print("\n" + "=" * 50)
        print(f"Sync completed in {time.time() - start_total:.1f}s")
        print("=" * 50)
        print(f"  Total People: {app_db.people_count()}")
        print(f"  Total Chats: {app_db.chat_count()}")
        print(f"  Total Messages: {app_db.message_count()}")
        if use_new_contacts_sync:
            active, deleted = app_db.get_contact_stats()
            print(f"  Total Contacts: {active} (active), {deleted} (deleted)")


if __name__ == "__main__":
    sync_all()
