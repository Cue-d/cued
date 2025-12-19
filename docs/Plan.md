# Personal CRM [PRM] Initial Dump

## Pre build

I want to go build a personal CRM, a tool that will level up the way I go and iterate on relationships. This, I call, the PRM. The most basic functionality and framework should be a fully local electron app with a python, fast API backend. The rationale here is I want the electron app to be an almost 1 to 1 copy of imessage. It should evoke the same feeling, as much as possible, while providing augmentations like a Cmd+K bar, filters, actions, etc. The fast API platform is required for on device finetuning on your text messages with MLX and apple silicon, to quickly get great texts in your own style that you can draft up en masse.

We are going to be reading  ~/Library/Messages/chat.db directly for access to message data using Full Disk Access. We will also be using Apple Script for access to contacts. Finally, we will need to port this imessage kit to allow messaging abilities down the line https://github.com/photon-hq/advanced-imessage-kit. 

We are also going to be writing a rust binary using Py03 to interface with the imessage sql database, by doing so, we can drastically reduce the amount of time spent interfacing with this database. 

For interacting with contacts, we will have to use Apple Script queries. For messages, we will have to dig through the photon codes library, for sending. 

In order for near instantaneous updates, we will be using a websocket to connect fastAPI backend to the electron frontend. What this means, in practical terms, is that we want imessages to show up on the screen at a moments notice after someone texts them. If we are using this approach, make sure to solve for SQLITE_BUSY, to allow reading and writing at the same time. 

We need to package Fast API and Rust as a singular binary that Electron spawns and embedded PyO3 as a module in the CI. This way the entire program builds together. 

We need to go about porting Photon Kit into Python in the most minimal possible way. 

Full GC support, how does it work in chat.db, implementation

# Examples 

## Code to access contacts (not all working but you get the picture)

```python
#!/usr/bin/env python3
"""
Contacts module - simple Mac Contacts integration with caching
"""

import subprocess
import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime

class Contact:
    def __init__(self, name: str, email: Optional[str] = None, phone: Optional[str] = None, 
                 emails: Optional[List[str]] = None, phones: Optional[List[str]] = None,
                 company: Optional[str] = None, job_title: Optional[str] = None,
                 birthday: Optional[str] = None, notes: Optional[str] = None,
                 addresses: Optional[List[str]] = None, platform: str = "contacts"):
        self.name = name
        self.email = email or (emails[0] if emails else None)
        self.phone = phone or (phones[0] if phones else None)
        self.emails = emails or []
        self.phones = phones or []
        self.company = company or ""
        self.job_title = job_title or ""
        self.birthday = birthday or ""
        self.notes = notes or ""
        self.addresses = addresses or []
        self.platform = platform

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "emails": self.emails,
            "phones": self.phones,
            "company": self.company,
            "job_title": self.job_title,
            "birthday": self.birthday,
            "notes": self.notes,
            "addresses": self.addresses,
            "platform": self.platform
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Contact':
        """Create Contact from dictionary"""
        return cls(**data)

class MacContactsDB:
    def __init__(self):
        self.cache_dir = Path.home() / ".prm" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.contacts_cache_file = self.cache_dir / "contacts_full.json"
        self.names_cache_file = self.cache_dir / "contact_names.json"

    def load_contacts_cache(self) -> Dict[str, Dict]:
        """Load contacts from cache"""
        try:
            if self.contacts_cache_file.exists():
                with open(self.contacts_cache_file, 'r') as f:
                    data = json.load(f)
                    return data.get('contacts', {})
        except Exception as e:
            print(f"Error loading contacts cache: {e}")
        return {}

    def load_names_cache(self) -> List[str]:
        """Load contact names from cache"""
        try:
            if self.names_cache_file.exists():
                with open(self.names_cache_file, 'r') as f:
                    data = json.load(f)
                    return data.get('names', [])
        except Exception as e:
            print(f"Error loading names cache: {e}")
        return []

    def save_names_cache(self, names: List[str]) -> None:
        """Save contact names to cache"""
        try:
            payload = {
                "timestamp": datetime.now().isoformat(),
                "count": len(names),
                "names": names,
            }
            with open(self.names_cache_file, 'w') as f:
                json.dump(payload, f, indent=2)
        except Exception as e:
            print(f"Error saving names cache: {e}")

    def resolve_identifier_to_name(self, identifier: str) -> str:
        """Resolve phone/email to contact name by searching contacts_full.json"""
        if identifier == "You" or not identifier:
            return identifier
        
        contacts_data = self.load_contacts_cache()
        
        # Search through all contacts
        for name, contact_data in contacts_data.items():
            # Check emails
            for email in contact_data.get('emails', []):
                if email and (email == identifier or email.lower() == identifier.lower()):
                    return name
            
            # Check phones with multiple formats
            for phone in contact_data.get('phones', []):
                if phone and self._phone_matches(phone, identifier):
                    return name
        
        # Return original if no match found
        return identifier
    
    def _phone_matches(self, stored_phone: str, identifier: str) -> bool:
        """Check if two phone numbers match in various formats"""
        if stored_phone == identifier:
            return True
        
        # Clean both numbers
        clean_stored = ''.join(c for c in stored_phone if c.isdigit() or c == '+')
        clean_identifier = ''.join(c for c in identifier if c.isdigit() or c == '+')
        
        if clean_stored == clean_identifier:
            return True
        
        # Try without + prefix
        if clean_stored.startswith('+') and clean_stored[1:] == clean_identifier:
            return True
        if clean_identifier.startswith('+') and clean_identifier[1:] == clean_stored:
            return True
        
        # Try with +1 prefix for US numbers
        if len(clean_stored) == 10 and clean_identifier in ['+1' + clean_stored, '1' + clean_stored]:
            return True
        if len(clean_identifier) == 10 and clean_stored in ['+1' + clean_identifier, '1' + clean_identifier]:
            return True
        
        # Try last 10 digits
        if len(clean_stored) >= 10 and len(clean_identifier) >= 10:
            if clean_stored[-10:] == clean_identifier[-10:]:
                return True
        
        return False

    def get_contacts(self) -> List[Contact]:
        """Get all contacts from cache"""
        contacts_data = self.load_contacts_cache()
        contacts = []

        for name, data in contacts_data.items():
            try:
                contact = Contact.from_dict(data)
                contacts.append(contact)
            except Exception as e:
                print(f"Error creating contact {name}: {e}")
        
        return contacts

    def get_contact_by_name(self, name: str) -> Optional[Contact]:
        """Get a specific contact by name"""
        contacts_data = self.load_contacts_cache()
        
        # Try exact match
        if name in contacts_data:
            return Contact.from_dict(contacts_data[name])
        
        # Try case-insensitive match
        for contact_name, data in contacts_data.items():
            if contact_name.lower() == name.lower():
                return Contact.from_dict(data)
        
        return None


    def fetch_contact_details(self, name: str) -> Optional[Contact]:
        """Fetch contact details from macOS Contacts app"""
        try:
            script = f'''
            tell application "Contacts"
                try
                    set targetPerson to first person whose name is "{name}"
                    set output to ""
                    
                    -- Name
                    set output to output & "NAME:" & name of targetPerson & return
                    
                    -- Company
                    try
                        set companyName to organization of targetPerson
                        if companyName is not missing value and companyName is not "" then
                            set output to output & "COMPANY:" & companyName & return
                        end if
                    end try
                    
                    -- Job Title
                    try
                        set jobTitle to job title of targetPerson
                        if jobTitle is not missing value and jobTitle is not "" then
                            set output to output & "JOB_TITLE:" & jobTitle & return
                        end if
                    end try
                    
                    -- Birthday
                    try
                        set bday to birth date of targetPerson
                        if bday is not missing value then
                            set output to output & "BIRTHDAY:" & (bday as string) & return
                        end if
                    end try
                    
                    -- Notes
                    try
                        set contactNote to note of targetPerson
                        if contactNote is not missing value and contactNote is not "" then
                            set output to output & "NOTE:" & contactNote & return
                        end if
                    end try
                    
                    -- Emails
                    try
                        set emailList to emails of targetPerson
                        repeat with anEmail in emailList
                            set emailValue to value of anEmail
                            set output to output & "EMAIL:" & emailValue & return
                        end repeat
                    end try
                    
                    -- Phones
                    try
                        set phoneList to phones of targetPerson
                        repeat with aPhone in phoneList
                            set phoneValue to value of aPhone
                            set output to output & "PHONE:" & phoneValue & return
                        end repeat
                    end try
                    
                    -- Addresses
                    try
                        set addressList to addresses of targetPerson
                        repeat with anAddress in addressList
                            set addressValue to formatted address of anAddress
                            set output to output & "ADDRESS:" & addressValue & return
                        end repeat
                    end try
                    
                    return output
                    
                on error errMsg
                    return "ERROR:" & errMsg
                end try
            end tell
            '''

            result = subprocess.run(['osascript', '-e', script],
                                     capture_output=True, text=True, timeout=10)

            if result.returncode != 0:
                return None

            output = result.stdout.strip()
            if not output or output.startswith("ERROR:"):
                return None
            
            # Parse the output
            contact_data = {
                "name": name,
                "company": "",
                "job_title": "",
                "birthday": "",
                "notes": "",
                "emails": [],
                "phones": [],
                "addresses": []
            }

            for line in output.split('\n'):
                line = line.strip()
                if not line:
                    continue

                if line.startswith('NAME:'):
                    contact_data["name"] = line[5:].strip()
                elif line.startswith('COMPANY:'):
                    contact_data["company"] = line[8:].strip()
                elif line.startswith('JOB_TITLE:'):
                    contact_data["job_title"] = line[10:].strip()
                elif line.startswith('BIRTHDAY:'):
                    contact_data["birthday"] = line[9:].strip()
                elif line.startswith('NOTE:'):
                    contact_data["notes"] = line[5:].strip()
                elif line.startswith('EMAIL:'):
                    email = line[6:].strip()
                    if email:
                        contact_data["emails"].append(email)
                elif line.startswith('PHONE:'):
                    phone = line[6:].strip()
                    if phone:
                        contact_data["phones"].append(phone)
                elif line.startswith('ADDRESS:'):
                    address = line[8:].strip()
                    if address:
                        contact_data["addresses"].append(address)

            return Contact.from_dict(contact_data)

        except Exception as e:
            print(f"Error fetching details for {name}: {e}")
            return None

    def fetch_contact_names(self) -> List[str]:
        """Fetch all contact names from macOS Contacts app (fast)"""
        names: List[str] = []
        try:
            script = '''
            tell application "Contacts"
                set nameList to {}
                set peopleList to people
                repeat with aPerson in peopleList
                    try
                        set end of nameList to name of aPerson
                    end try
                end repeat
                return nameList
            end tell
            '''
            result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                err = result.stderr.strip()
                if err:
                    print(f"AppleScript error fetching names: {err}")
                return names
            output = result.stdout.strip()
            if output:
                output = output.strip('{}')
                if output:
                    names = [n.strip().strip('"') for n in output.split(',') if n.strip()]
        except subprocess.TimeoutExpired:
            print("AppleScript timed out while fetching names")
        except Exception as e:
            print(f"Error fetching contact names: {e}")
        return names

    def hydrate_all_contacts(self):
        """Hydrate all contacts from the names cache"""
        names_cache_file = self.names_cache_file
        if not names_cache_file.exists():
            print("No contact names cache found. Run 'python3 contacts.py gen-names' first.")
            return
        
        # Load names
        try:
            with open(names_cache_file, 'r') as f:
                data = json.load(f)
                names = data.get('names', [])
        except Exception as e:
            print(f"Error loading names: {e}")
            return
        
        print(f"Hydrating {len(names)} contacts...")
        
        contacts = {}
        
        for i, name in enumerate(names):
            print(f"Processing {i+1}/{len(names)}: {name}")
            
            contact = self.fetch_contact_details(name)
            if contact:
                contacts[name] = contact.to_dict()
            
            # Save progress every 50 contacts
            if (i + 1) % 50 == 0:
                self._save_contacts(contacts)
        
        # Final save
        self._save_contacts(contacts)
        print(f"Hydration complete! Processed {len(contacts)} contacts.")

    def get_status(self) -> Dict[str, Any]:
        """Return status about cached names and contacts."""
        status: Dict[str, Any] = {
            "names_cache_exists": self.names_cache_file.exists(),
            "contacts_cache_exists": self.contacts_cache_file.exists(),
            "names_count": 0,
            "contacts_count": 0,
            "names_cache_path": str(self.names_cache_file),
            "contacts_cache_path": str(self.contacts_cache_file),
        }
        try:
            status["names_count"] = len(self.load_names_cache())
        except Exception:
            pass
        try:
            status["contacts_count"] = len(self.load_contacts_cache())
        except Exception:
            pass
        return status

    def _save_contacts(self, contacts: Dict):
        """Save contacts to cache file"""
        contacts_data = {
            "timestamp": datetime.now().isoformat(),
            "count": len(contacts),
            "contacts": contacts
        }
        
        with open(self.contacts_cache_file, 'w') as f:
            json.dump(contacts_data, f, indent=2)

if __name__ == "__main__":
    db = MacContactsDB()
    args = sys.argv[1:]

    # Default action: print status
    if not args or args[0] in ["status", "--status", "-s"]:
        st = db.get_status()
        print(json.dumps(st, indent=2))
        sys.exit(0)

    cmd = args[0]
    if cmd in ["gen-names", "names", "fetch-names"]:
        print("Fetching contact names from macOS Contacts…")
        names = db.fetch_contact_names()
        print(f"Discovered {len(names)} names. Saving to cache…")
        db.save_names_cache(names)
        st = db.get_status()
        print(json.dumps(st, indent=2))
        sys.exit(0)
    elif cmd in ["hydrate", "hydrate-all"]:
        db.hydrate_all_contacts()
        st = db.get_status()
        print(json.dumps(st, indent=2))
        sys.exit(0)
    else:
        print("Usage: python3 contacts.py [status|gen-names|hydrate]")
        sys.exit(1)
```

## Code to access messages, this will ideally be replaced by rust. the goal is to use rust as the method of querying the imessage sql database for fast search 

```python
#!/usr/bin/env python3
"""
Messages module - handles iMessage integration
"""

import sqlite3
import re
from pathlib import Path
from typing import List, Optional, Dict

class MessageData:
    def __init__(self, sender: str, recipient: str, content: str, timestamp: str, platform: str = "imessage"):
        self.sender = sender
        self.recipient = recipient
        self.content = content
        self.timestamp = timestamp
        self.platform = platform

class MacMessagesDB:
    def __init__(self):
        self.messages_db_path = Path.home() / "Library" / "Messages" / "chat.db"
        self._contacts_db = None

    def _extract_text_from_attributed_body(self, attributed_body: bytes) -> Optional[str]:
        """Extract clean text from NSAttributedString binary data"""
        if not attributed_body:
            return None
        
        try:
            # The format is: ...NSString\x01\x01+MESSAGE_TEXT\x02iI...
            # Find the position of the + character after NSString
            plus_idx = attributed_body.find(b'+')
            if plus_idx == -1:
                return None
            
            # Find the end marker \x02iI after the +
            end_marker = attributed_body.find(b'\x02iI', plus_idx)
            if end_marker == -1:
                # Try alternative end marker
                end_marker = attributed_body.find(b'\x02', plus_idx)
                if end_marker == -1:
                    return None
            
            # Extract the message text between + and end marker
            message_bytes = attributed_body[plus_idx + 1:end_marker]
            
            # Decode and clean
            message_text = message_bytes.decode('utf-8', errors='ignore').strip()
            
            # Filter out empty or very short messages
            if len(message_text) > 0:
                # Remove any remaining control characters but keep newlines and tabs
                clean_text = ''.join(c for c in message_text if c.isprintable() or c in '\n\t')
                return clean_text if clean_text else None
            
            return None
            
        except Exception as e:
            print(f"Error extracting text from attributed body: {e}")
            return None

    def get_contacts_db(self):
        """Get contacts database instance"""
        if self._contacts_db is None:
            try:
                from contacts import MacContactsDB
                self._contacts_db = MacContactsDB()
            except Exception as e:
                print(f"Error loading contacts database: {e}")
                self._contacts_db = None
        return self._contacts_db

    def resolve_identifier_to_name(self, identifier: str) -> str:
        """Resolve phone/email to contact name"""
        if identifier == "You" or not identifier:
            return identifier
        
        contacts_db = self.get_contacts_db()
        if contacts_db:
            return contacts_db.resolve_identifier_to_name(identifier)
        
        # Return original if no contacts database available
        return identifier

    def get_contact_mappings(self) -> Dict[str, str]:
        """Get mappings between contact IDs and display names from iMessage database"""
        mappings = {}

        if not self.messages_db_path.exists():
            return mappings

        try:
            conn = sqlite3.connect(str(self.messages_db_path))
            cursor = conn.cursor()

            # Check what columns are available in handle table
            cursor.execute("PRAGMA table_info(handle)")
            columns = [col[1] for col in cursor.fetchall()]

            # Query to get display names for contact IDs - use available columns
            if 'display_name' in columns:
                query = """
                SELECT handle.id, handle.display_name
                FROM handle
                WHERE handle.display_name IS NOT NULL
                """
            else:
                # Fallback to using id as the identifier if display_name doesn't exist
                query = """
                SELECT handle.id, handle.id
                FROM handle
                """

            cursor.execute(query)
            rows = cursor.fetchall()

            for row in rows:
                contact_id = row[0]
                display_name = row[1]
                if contact_id and display_name:
                    mappings[contact_id] = display_name

            conn.close()

        except Exception as e:
            print(f"Error getting contact mappings: {e}")

        return mappings

    def get_messages(self, limit: int = 100) -> List[MessageData]:
        """Get recent messages from iMessage database"""
        messages = []

        if not self.messages_db_path.exists():
            print(f"Messages database not found at {self.messages_db_path}")
            return messages

        try:
            conn = sqlite3.connect(str(self.messages_db_path))
            cursor = conn.cursor()

            # Check what columns are available in handle table
            cursor.execute("PRAGMA table_info(handle)")
            handle_columns = [col[1] for col in cursor.fetchall()]

            # Query to get recent messages with sender info
            if 'display_name' in handle_columns:
                query = """
                SELECT
                    message.text,
                    message.is_from_me,
                    handle.id as contact_id,
                    datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
                    message.attributedBody,
                    handle.display_name
                FROM message
                LEFT JOIN handle ON message.handle_id = handle.ROWID
                WHERE message.text IS NOT NULL OR message.attributedBody IS NOT NULL
                ORDER BY message.date DESC
                LIMIT ?
                """
            else:
                query = """
                SELECT
                    message.text,
                    message.is_from_me,
                    handle.id as contact_id,
                    datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
                    message.attributedBody,
                    handle.id as display_name
                FROM message
                LEFT JOIN handle ON message.handle_id = handle.ROWID
                WHERE message.text IS NOT NULL OR message.attributedBody IS NOT NULL
                ORDER BY message.date DESC
                LIMIT ?
                """

            cursor.execute(query, (limit,))
            rows = cursor.fetchall()

            for row in rows:
                text = row[0]
                is_from_me = row[1]
                contact_id = row[2] or "Unknown"
                timestamp = row[3] or "Unknown"
                attributed_body = row[4]
                display_name = row[5] if len(row) > 5 else contact_id

                # Handle newer message format (attributedBody)
                if not text and attributed_body:
                    text = self._extract_text_from_attributed_body(attributed_body)
                    if not text:
                        text = "[Media or unsupported content]"

                if text:
                    # Resolve to contact names
                    if is_from_me:
                        sender_name = "You"
                        recipient_name = self.resolve_identifier_to_name(contact_id)
                    else:
                        sender_name = self.resolve_identifier_to_name(contact_id)
                        recipient_name = "You"

                    messages.append(MessageData(
                        sender=sender_name,
                        recipient=recipient_name,
                        content=text,
                        timestamp=timestamp,
                        platform="imessage"
                    ))

            conn.close()

        except Exception as e:
            print(f"Error accessing messages database: {e}")

        return messages

    def get_messages_for_contact(self, contact_identifier: str, limit: int = 50) -> List[MessageData]:
        """Get messages for a specific contact by ID, email, phone, or display name"""
        messages = []

        if not self.messages_db_path.exists():
            return messages

        try:
            conn = sqlite3.connect(str(self.messages_db_path))
            cursor = conn.cursor()

            # Check what columns are available in handle table
            cursor.execute("PRAGMA table_info(handle)")
            handle_columns = [col[1] for col in cursor.fetchall()]

            # Query to find messages for contact by multiple identifiers
            if 'display_name' in handle_columns:
                query = """
                SELECT
                    message.text,
                    message.is_from_me,
                    handle.id as contact_id,
                    datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
                    message.attributedBody,
                    handle.display_name
                FROM message
                LEFT JOIN handle ON message.handle_id = handle.ROWID
                WHERE (handle.id = ? OR handle.display_name = ?)
                AND (message.text IS NOT NULL OR message.attributedBody IS NOT NULL)
                ORDER BY message.date DESC
                LIMIT ?
                """
            else:
                query = """
                SELECT
                    message.text,
                    message.is_from_me,
                    handle.id as contact_id,
                    datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
                    message.attributedBody,
                    handle.id as display_name
                FROM message
                LEFT JOIN handle ON message.handle_id = handle.ROWID
                WHERE handle.id = ?
                AND (message.text IS NOT NULL OR message.attributedBody IS NOT NULL)
                ORDER BY message.date DESC
                LIMIT ?
                """

            cursor.execute(query, (contact_identifier, contact_identifier, limit) if 'display_name' in handle_columns else (contact_identifier, limit))
            rows = cursor.fetchall()

            for row in rows:
                text = row[0]
                is_from_me = row[1]
                contact_id_result = row[2] or "Unknown"
                timestamp = row[3] or "Unknown"
                attributed_body = row[4]
                display_name = row[5] if len(row) > 5 else contact_id_result

                # Handle newer message format
                if not text and attributed_body:
                    text = self._extract_text_from_attributed_body(attributed_body)
                    if not text:
                        text = "[Media or unsupported content]"

                if text:
                    # Resolve to contact names
                    if is_from_me:
                        sender_name = "You"
                        recipient_name = self.resolve_identifier_to_name(contact_id_result)
                    else:
                        sender_name = self.resolve_identifier_to_name(contact_id_result)
                        recipient_name = "You"

                    messages.append(MessageData(
                        sender=sender_name,
                        recipient=recipient_name,
                        content=text,
                        timestamp=timestamp,
                        platform="imessage"
                    ))

            conn.close()

        except Exception as e:
            print(f"Error accessing messages for contact: {e}")

        return messages

    def find_contact_by_info(self, email_or_phone: str) -> Optional[str]:
        """Find contact ID by email or phone number"""
        if not self.messages_db_path.exists():
            return None

        try:
            conn = sqlite3.connect(str(self.messages_db_path))
            cursor = conn.cursor()

            # Check what columns are available in handle table
            cursor.execute("PRAGMA table_info(handle)")
            handle_columns = [col[1] for col in cursor.fetchall()]

            # Try to find by display name if available
            if 'display_name' in handle_columns:
                query = """
                SELECT handle.id
                FROM handle
                WHERE handle.display_name = ?
                """
                cursor.execute(query, (email_or_phone,))
                result = cursor.fetchone()

                if result:
                    conn.close()
                    return result[0]

                # Try pattern matching
                query = """
                SELECT handle.id, handle.display_name
                FROM handle
                WHERE handle.display_name LIKE ?
                """
                cursor.execute(query, (f"%{email_or_phone}%",))
                results = cursor.fetchall()

                for row in results:
                    contact_id, display_name = row
                    if email_or_phone.lower() in display_name.lower():
                        conn.close()
                        return contact_id
            else:
                # If no display_name column, just try to match by handle.id
                query = """
                SELECT handle.id
                FROM handle
                WHERE handle.id = ?
                """
                cursor.execute(query, (email_or_phone,))
                result = cursor.fetchone()

                if result:
                    conn.close()
                    return result[0]

            conn.close()

        except Exception as e:
            print(f"Error finding contact by info: {e}")

        return None


```