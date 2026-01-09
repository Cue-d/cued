"""
Apple Contacts fetching via Swift CLI (Contacts.framework).

Uses the prm-contacts binary for high-performance contact retrieval (~100x faster
than AppleScript). Falls back gracefully with clear error messages if unavailable.

Note on notes field:
    The Swift CLI does not return contact notes because fetching notes requires
    the com.apple.developer.contacts.notes entitlement, which requires Apple
    approval. The FetchedContact.notes field will always be None when using
    the Swift CLI.
"""

import json
import logging
import os
import subprocess
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Default path to the prm-contacts binary (relative to project root, for development)
DEFAULT_CONTACTS_BINARY_PATH = (
    Path(__file__).parent.parent.parent.parent / "llm" / ".build" / "release" / "prm-contacts"
)

# Environment variable to override the binary path
CONTACTS_BINARY_ENV_VAR = "PRM_CONTACTS_BINARY"

# Timeout for contacts fetch (seconds)
CONTACTS_TIMEOUT = 30


class ContactsError(Exception):
    """Error from the contacts CLI."""


class ContactsAccessDeniedError(ContactsError):
    """Contacts access was denied - user needs to grant permission."""

    pass


class FetchedContact(BaseModel):
    """Contact fetched from Apple Contacts."""

    name: str
    emails: list[str] = []
    phones: list[str] = []
    company: str | None = None
    notes: str | None = None  # Always None - see module docstring


def _get_packaged_contacts_path() -> Path | None:
    """Get the contacts binary path when running as a packaged PyInstaller executable.

    When packaged with Electron, the layout is:
        resources/
            backend/prm-backend  (PyInstaller executable)
            llm/prm-contacts     (Swift binary)
    """
    import sys

    if not getattr(sys, "frozen", False):
        return None

    executable_path = Path(sys.executable)
    contacts_path = executable_path.parent.parent / "llm" / "prm-contacts"
    return contacts_path


def get_contacts_binary_path() -> Path:
    """Get the path to the prm-contacts binary.

    Checks in order:
    1. Environment variable PRM_CONTACTS_BINARY
    2. Packaged app location (resources/llm/prm-contacts)
    3. Development location (llm/.build/release/prm-contacts)
    """
    env_path = os.environ.get(CONTACTS_BINARY_ENV_VAR)
    if env_path:
        return Path(env_path)

    packaged_path = _get_packaged_contacts_path()
    if packaged_path and packaged_path.exists():
        return packaged_path

    return DEFAULT_CONTACTS_BINARY_PATH


def is_swift_contacts_available() -> bool:
    """Check if the Swift contacts CLI is available.

    Returns:
        True if the binary exists and is executable, False otherwise.

    Note:
        When False, check get_contacts_binary_path() for the attempted path.
    """
    binary_path = get_contacts_binary_path()
    available = binary_path.exists() and os.access(binary_path, os.X_OK)
    if not available:
        logger.debug(f"Swift contacts CLI not available at {binary_path}")
    return available


def fetch_all_contacts() -> list[FetchedContact]:
    """Fetch all contacts from Apple Contacts using Swift CLI.

    Returns:
        List of FetchedContact objects (only contacts with phone or email)

    Raises:
        ContactsAccessDeniedError: If contacts access is denied (exit code 2)
        ContactsError: If the Swift CLI is unavailable or fails
    """
    binary_path = get_contacts_binary_path()

    if not is_swift_contacts_available():
        raise ContactsError(f"Swift contacts binary not found at {binary_path}")

    try:
        result = subprocess.run(
            [str(binary_path), "--json"],
            capture_output=True,
            text=True,
            timeout=CONTACTS_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise ContactsError(f"Contacts fetch timed out after {CONTACTS_TIMEOUT}s") from None

    # Check for access denied (exit code 2)
    if result.returncode == 2:
        error_msg = _parse_error(result.stderr) or "Contacts access denied"
        raise ContactsAccessDeniedError(error_msg)

    if result.returncode != 0:
        error_msg = _parse_error(result.stderr) or f"Unknown error (exit code {result.returncode})"
        raise ContactsError(f"Contacts fetch failed: {error_msg}")

    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ContactsError(f"Invalid JSON from contacts CLI: {e}") from e

    # Validate and parse contacts
    contacts = []
    raw_contacts = output.get("contacts", [])

    if not isinstance(raw_contacts, list):
        raise ContactsError("Invalid JSON structure: 'contacts' must be an array")

    for i, c in enumerate(raw_contacts):
        if not isinstance(c, dict):
            raise ContactsError(f"Invalid JSON structure: contact at index {i} must be an object")

        if "name" not in c:
            raise ContactsError(
                f"Invalid JSON structure: contact at index {i} missing required 'name' field"
            )

        contacts.append(
            FetchedContact(
                name=c["name"],
                emails=c.get("emails", []),
                phones=c.get("phones", []),
                company=c.get("company"),
                notes=None,  # Not available from Swift CLI
            )
        )

    elapsed = output.get("elapsed_seconds", 0)
    logger.info(f"Fetched {len(contacts)} contacts via Swift CLI in {elapsed:.3f}s")
    return contacts


def _parse_error(stderr: str) -> str | None:
    """Parse error message from stderr JSON."""
    if not stderr:
        return None
    try:
        error_data = json.loads(stderr.strip())
        return error_data.get("error")
    except json.JSONDecodeError:
        return stderr.strip() or None
