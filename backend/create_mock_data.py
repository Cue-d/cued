#!/usr/bin/env python3
"""
Generate mock data for testing the PRM action queue.

This script creates:
- Mock people (contacts)
- Mock chats (1:1 and group)
- Mock messages with realistic conversation threads
- Mock actions (respond_to_message, eod_contact, follow_up)

Usage:
    cd backend
    uv run python create_mock_data.py

The script will create/update the database at ~/.prm/prm.db
"""

import json
import os
import sqlite3
import time

import core

# Database path
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")


# Mock data definitions
MOCK_PEOPLE = [
    {
        "id": 1,
        "identifier": "+15551234567",
        "name": "Sarah Chen",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 2,
        "identifier": "+15559876543",
        "name": "Mike Thompson",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 3,
        "identifier": "+15555551234",
        "name": "Emily Rodriguez",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 4,
        "identifier": "+15552223333",
        "name": "Alex Kim",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 5,
        "identifier": "+15554445555",
        "name": "Jordan Wright",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 6,
        "identifier": "+15556667777",
        "name": "David Park",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 7,
        "identifier": "+15558889999",
        "name": "Lisa Martinez",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 8,
        "identifier": "taylor@gmail.com",
        "name": "Taylor Swift",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 9,
        "identifier": "+15551112222",
        "name": "Chris Evans",
        "service": "iMessage",
        "is_contact": True,
    },
    {
        "id": 10,
        "identifier": "+15553334444",
        "name": "Jessica Lee",
        "service": "iMessage",
        "is_contact": True,
    },
]

MOCK_CHATS = [
    # 1:1 chats
    {
        "id": 1,
        "identifier": "chat123456",
        "is_group": False,
        "name": "Sarah Chen",
        "participants": [1],
    },
    {
        "id": 2,
        "identifier": "chat234567",
        "is_group": False,
        "name": "Mike Thompson",
        "participants": [2],
    },
    {
        "id": 3,
        "identifier": "chat345678",
        "is_group": False,
        "name": "Emily Rodriguez",
        "participants": [3],
    },
    {
        "id": 4,
        "identifier": "chat456789",
        "is_group": False,
        "name": "Alex Kim",
        "participants": [4],
    },
    {
        "id": 5,
        "identifier": "chat567890",
        "is_group": False,
        "name": "Jordan Wright",
        "participants": [5],
    },
    {
        "id": 6,
        "identifier": "chat678901",
        "is_group": False,
        "name": "David Park",
        "participants": [6],
    },
    # Group chats
    {
        "id": 7,
        "identifier": "chat;-;789012",
        "is_group": True,
        "name": "Weekend Plans",
        "participants": [1, 2, 3],
    },
    {
        "id": 8,
        "identifier": "chat;-;890123",
        "is_group": True,
        "name": "Work Project",
        "participants": [4, 5, 6, 7],
    },
]

# Realistic conversation threads
CONVERSATION_TEMPLATES = {
    1: [  # Sarah Chen - project discussion
        {"text": "Hey! How's the project going?", "is_from_me": False, "minutes_ago": 60},
        {
            "text": "It's going well! Just finished the new feature",
            "is_from_me": True,
            "minutes_ago": 55,
        },
        {
            "text": "Nice! Can we catch up tomorrow to discuss next steps?",
            "is_from_me": False,
            "minutes_ago": 30,
        },
    ],
    2: [  # Mike Thompson - casual/sports
        {"text": "Did you see the game last night?", "is_from_me": False, "minutes_ago": 120},
        {"text": "Yes! What a finish!", "is_from_me": True, "minutes_ago": 115},
        {
            "text": "We should watch the next one together. I'm hosting at my place",
            "is_from_me": False,
            "minutes_ago": 60,
        },
    ],
    3: [  # Emily Rodriguez - professional networking
        {
            "text": "Thanks for the introduction to your contact at TechCorp",
            "is_from_me": False,
            "minutes_ago": 1440,
        },
        {"text": "Happy to help! Let me know how it goes", "is_from_me": True, "minutes_ago": 1430},
        {
            "text": (
                "The meeting went great! They want to move forward. "
                "Coffee next week to celebrate?"
            ),
            "is_from_me": False,
            "minutes_ago": 20,
        },
    ],
    4: [  # Alex Kim - new contact (EOD)
        {"text": "Great meeting you at the mixer!", "is_from_me": False, "minutes_ago": 180},
        {
            "text": "Likewise! Would love to chat more about your startup",
            "is_from_me": True,
            "minutes_ago": 175,
        },
    ],
    5: [  # Jordan Wright - coffee meeting (EOD)
        {"text": "Thanks for the coffee chat today", "is_from_me": False, "minutes_ago": 120},
        {
            "text": "Really insightful conversation about AI",
            "is_from_me": False,
            "minutes_ago": 119,
        },
    ],
    6: [  # David Park - follow up needed
        {
            "text": "Let me know if you hear anything about the opening",
            "is_from_me": True,
            "minutes_ago": 10080,
        },  # 7 days
        {"text": "Will do!", "is_from_me": False, "minutes_ago": 10070},
    ],
    7: [  # Group: Weekend Plans
        {
            "text": "Anyone free this Saturday?",
            "is_from_me": False,
            "minutes_ago": 240,
            "sender_id": 1,
        },
        {"text": "I'm in!", "is_from_me": True, "minutes_ago": 235},
        {
            "text": "Same here, what's the plan?",
            "is_from_me": False,
            "minutes_ago": 230,
            "sender_id": 2,
        },
        {
            "text": "Thinking hiking at the state park then brunch?",
            "is_from_me": False,
            "minutes_ago": 45,
            "sender_id": 3,
        },
    ],
    8: [  # Group: Work Project
        {
            "text": "Q4 deadline is coming up",
            "is_from_me": False,
            "minutes_ago": 480,
            "sender_id": 4,
        },
        {"text": "I've got the frontend ready", "is_from_me": True, "minutes_ago": 470},
        {"text": "Backend is 80% done", "is_from_me": False, "minutes_ago": 460, "sender_id": 5},
        {
            "text": "Can we sync tomorrow at 2pm?",
            "is_from_me": False,
            "minutes_ago": 90,
            "sender_id": 6,
        },
    ],
}


def now_ts() -> int:
    """Current timestamp in milliseconds (matching iMessage format)."""
    return int(time.time() * 1000)


def minutes_ago_ts(minutes: int) -> int:
    """Timestamp for N minutes ago in milliseconds."""
    return now_ts() - (minutes * 60 * 1000)


def create_mock_people(db: core.AppDb) -> None:
    """Insert mock people into the database."""
    print("Creating mock people...")
    for person in MOCK_PEOPLE:
        db.upsert_person(
            id=person["id"],
            identifier=person["identifier"],
            name=person["name"],
            service=person["service"],
            is_contact=person["is_contact"],
            phones=json.dumps([person["identifier"]])
            if person["identifier"].startswith("+")
            else None,
            emails=json.dumps([person["identifier"]]) if "@" in person["identifier"] else None,
            company=None,
            notes=None,
        )
    print(f"  Created {len(MOCK_PEOPLE)} people")


def create_mock_chats(conn: sqlite3.Connection) -> None:
    """Insert mock chats into the database using raw SQL."""
    print("Creating mock chats...")
    cursor = conn.cursor()

    for chat in MOCK_CHATS:
        cursor.execute(
            """
            INSERT OR REPLACE INTO chats (id, identifier, name, is_group, synced_at)
            VALUES (?, ?, ?, ?, ?)
        """,
            (
                chat["id"],
                chat["identifier"],
                chat["name"],
                1 if chat["is_group"] else 0,
                int(time.time()),
            ),
        )

    # Insert chat participants
    cursor.execute("DELETE FROM chat_participants")
    for chat in MOCK_CHATS:
        for person_id in chat["participants"]:
            cursor.execute(
                """
                INSERT OR REPLACE INTO chat_participants (chat_id, person_id)
                VALUES (?, ?)
            """,
                (chat["id"], person_id),
            )

    conn.commit()
    print(f"  Created {len(MOCK_CHATS)} chats")


def create_mock_messages(conn: sqlite3.Connection) -> None:
    """Insert mock messages into the database using raw SQL."""
    print("Creating mock messages...")
    cursor = conn.cursor()

    message_id = 1000
    messages_created = 0

    for chat_id, conversation in CONVERSATION_TEMPLATES.items():
        chat_info = next((c for c in MOCK_CHATS if c["id"] == chat_id), None)
        if not chat_info:
            continue

        for msg in conversation:
            # Determine sender
            if msg["is_from_me"]:
                sender_id = None
            elif chat_info["is_group"] and "sender_id" in msg:
                sender_id = msg["sender_id"]
            else:
                sender_id = chat_info["participants"][0] if chat_info["participants"] else None

            timestamp = minutes_ago_ts(msg["minutes_ago"])
            read_at = minutes_ago_ts(msg["minutes_ago"] - 1) if not msg["is_from_me"] else None

            cursor.execute(
                """
                INSERT OR REPLACE INTO messages 
                (id, chat_id, sender_id, text, timestamp, is_from_me, 
                 is_read, read_at, has_attachments, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    message_id,
                    chat_id,
                    sender_id,
                    msg["text"],
                    timestamp,
                    1 if msg["is_from_me"] else 0,
                    1,
                    read_at,
                    0,  # has_attachments
                    int(time.time()),  # synced_at
                ),
            )
            message_id += 1
            messages_created += 1

    conn.commit()
    print(f"  Created {messages_created} messages")


def create_mock_actions(db: core.AppDb) -> None:
    """Create mock actions for testing the action queue."""
    print("Creating mock actions...")

    actions = [
        # Respond to message actions
        {
            "type": "respond_to_message",
            "priority": 80,
            "chat_id": 1,
            "person_id": 1,
            "message_id": 1002,
            "payload": {"message_preview": "Can we catch up tomorrow?", "hours_since": 0.5},
        },
        {
            "type": "respond_to_message",
            "priority": 70,
            "chat_id": 2,
            "person_id": 2,
            "message_id": 1005,
            "payload": {"message_preview": "I'm hosting at my place", "hours_since": 1},
        },
        {
            "type": "respond_to_message",
            "priority": 90,
            "chat_id": 3,
            "person_id": 3,
            "message_id": 1008,
            "payload": {"message_preview": "Coffee next week to celebrate?", "hours_since": 0.3},
        },
        {
            "type": "respond_to_message",
            "priority": 60,
            "chat_id": 7,
            "person_id": 3,
            "message_id": None,
            "payload": {
                "message_preview": "Thinking hiking at the state park?",
                "hours_since": 0.75,
            },
        },
        {
            "type": "respond_to_message",
            "priority": 75,
            "chat_id": 8,
            "person_id": 6,
            "message_id": None,
            "payload": {"message_preview": "Can we sync tomorrow at 2pm?", "hours_since": 1.5},
        },
        # EOD contact actions (new contacts met today)
        {
            "type": "eod_contact",
            "priority": 50,
            "chat_id": None,
            "person_id": 4,
            "message_id": None,
            "payload": {"met_at": "3:30 PM", "location": "Startup Mixer @ The Hub"},
        },
        {
            "type": "eod_contact",
            "priority": 45,
            "chat_id": None,
            "person_id": 5,
            "message_id": None,
            "payload": {"met_at": "5:00 PM", "location": "Coffee at Blue Bottle"},
        },
        # Follow up actions
        {
            "type": "follow_up",
            "priority": 40,
            "chat_id": 6,
            "person_id": 6,
            "message_id": None,
            "payload": {"reason": "Check in about job application", "last_contact_days": 7},
            "remind_at": now_ts(),
        },
    ]

    for action in actions:
        payload_json = json.dumps(action["payload"]) if action.get("payload") else None
        db.create_action(
            action_type=action["type"],
            priority=action["priority"],
            chat_id=action.get("chat_id"),
            person_id=action.get("person_id"),
            message_id=action.get("message_id"),
            payload=payload_json,
            remind_at=action.get("remind_at"),
        )

    print(f"  Created {len(actions)} actions")


def main():
    print("=" * 60)
    print("PRM Mock Data Generator")
    print("=" * 60)
    print(f"\nDatabase path: {APP_DB_PATH}")

    # Ensure directory exists
    os.makedirs(os.path.dirname(APP_DB_PATH), exist_ok=True)

    # Open database and initialize schema via Rust
    print("\nInitializing database...")
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()

    # Open raw SQLite connection for direct inserts
    conn = sqlite3.connect(APP_DB_PATH)

    # Clear existing mock data
    print("\nClearing existing mock data...")
    cursor = conn.cursor()
    cursor.execute("DELETE FROM actions WHERE id <= 100")  # Only delete mock actions
    conn.commit()

    # Create mock data
    print("\n--- Creating Mock Data ---")
    create_mock_people(db)
    create_mock_chats(conn)
    create_mock_messages(conn)
    create_mock_actions(db)

    conn.close()

    # Print summary
    print("\n" + "=" * 60)
    print("Mock data created successfully!")
    print("=" * 60)
    print(f"  People: {db.people_count()}")
    print(f"  Chats: {db.chat_count()}")
    print(f"  Messages: {db.message_count()}")
    pending = db.get_pending_actions(100)
    print(f"  Pending Actions: {len(pending)}")
    print("\nYou can now start the backend server:")
    print("  cd backend && uv run uvicorn main:app --reload")


if __name__ == "__main__":
    main()
