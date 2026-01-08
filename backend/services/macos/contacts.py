"""Apple Contacts fetching via AppleScript."""

import subprocess

from pydantic import BaseModel

CONTACT_DELIMITER = "<<<CONTACT>>>"


class FetchedContact(BaseModel):
    """Contact fetched from Apple Contacts."""

    name: str
    emails: list[str] = []
    phones: list[str] = []
    company: str | None = None
    notes: str | None = None


def fetch_all_contact_names() -> list[str]:
    """Fetch all contact names from Apple Contacts."""
    script = """
        tell application "Contacts"
            launch
            set nameList to {}
            repeat with aPerson in people
                try
                    set end of nameList to name of aPerson
                end try
            end repeat
            return nameList
        end tell
    """

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"osascript failed: {result.stderr}")

    # Parse AppleScript list output: {name1, name2, ...}
    output = result.stdout.strip()
    cleaned = output.lstrip("{").rstrip("}")
    names = [n.strip().strip('"') for n in cleaned.split(",") if n.strip() and n.strip() != '""']

    return names


def fetch_contacts_by_names(names: list[str]) -> list[FetchedContact]:
    """Fetch contact details for a list of names."""
    if not names:
        return []

    # Build AppleScript list of names
    names_list = ", ".join(f'"{n.replace(chr(34), chr(92) + chr(34))}"' for n in names)

    script = f"""
        tell application "Contacts"
            launch
            set nameList to {{{names_list}}}
            set output to ""

            repeat with targetName in nameList
                try
                    -- Get ALL people matching this name (not just first)
                    set matchingPeople to every person whose name is targetName
                    repeat with p in matchingPeople
                        set output to output & "NAME:" & name of p & return
                        try
                            set output to output & "COMPANY:" & organization of p & return
                        end try
                        try
                            set output to output & "NOTE:" & note of p & return
                        end try
                        repeat with e in emails of p
                            set output to output & "EMAIL:" & value of e & return
                        end repeat
                        repeat with ph in phones of p
                            set output to output & "PHONE:" & value of ph & return
                        end repeat
                        set output to output & "{CONTACT_DELIMITER}" & return
                    end repeat
                on error
                end try
            end repeat

            return output
        end tell
    """

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"osascript failed: {result.stderr}")

    contacts = []
    for block in result.stdout.split(CONTACT_DELIMITER):
        contact = _parse_contact_block(block)
        if contact:
            contacts.append(contact)

    return contacts


def _parse_contact_block(block: str) -> FetchedContact | None:
    """Parse a contact block from AppleScript output."""
    name = ""
    emails: list[str] = []
    phones: list[str] = []
    company: str | None = None
    notes: str | None = None
    has_data = False

    # AppleScript uses \r for line breaks
    for line in block.replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue

        if line.startswith("NAME:"):
            name = line[5:].strip()
            has_data = True
        elif line.startswith("COMPANY:"):
            value = line[8:].strip()
            if value and value != "missing value":
                company = value
        elif line.startswith("NOTE:"):
            value = line[5:].strip()
            if value and value != "missing value":
                notes = value
        elif line.startswith("EMAIL:"):
            value = line[6:].strip()
            if value:
                emails.append(value)
        elif line.startswith("PHONE:"):
            value = line[6:].strip()
            if value:
                phones.append(value)

    if has_data and name:
        return FetchedContact(
            name=name,
            emails=emails,
            phones=phones,
            company=company,
            notes=notes,
        )

    return None
