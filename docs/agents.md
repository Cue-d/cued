# PRM Architecture

## Overview

PRM is a three-tier Electron app that reads your iMessage database and presents it in an iMessage-style UI.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Frontend (Electron)                              │
│  ┌─────────────────┐    IPC     ┌──────────────────┐                     │
│  │  React Renderer │◀──────────▶│   Main Process   │                     │
│  │  (App.tsx)      │            │   (index.ts)     │                     │
│  └─────────────────┘            └────────┬─────────┘                     │
└──────────────────────────────────────────│───────────────────────────────┘
                                           │ HTTP (localhost:8000)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          Backend (FastAPI)                                │
│  main.py ─ REST endpoints + HandleResolver for contact name lookups      │
│  sync_contacts.py ─ CLI script to import contacts from macOS             │
└──────────────────────────────────────────┬───────────────────────────────┘
                                           │ PyO3
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Core (Rust/PyO3)                                │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                 │
│  │  ChatReader   │  │    AppDb      │  │   contacts    │                 │
│  │ (chat.db R/O) │  │  (prm.db)     │  │ (AppleScript) │                 │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘                 │
│          │                  │                  │                          │
│          ▼                  ▼                  ▼                          │
│   ~/Library/Messages    ~/.prm/prm.db    macOS Contacts                  │
│       chat.db                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Core (Rust)

**Location:** `core/src/`

High-performance database layer exposed to Python via PyO3.

| File | Exports | Purpose |
|------|---------|---------|
| `lib.rs` | `core` module | PyO3 entry point |
| `chat_reader.rs` | `ChatReader` | Read-only access to iMessage `chat.db` |
| `app_db.rs` | `AppDb` | Read/write access to app database `prm.db` |
| `contacts.rs` | `fetch_all_contact_names`, `fetch_contacts_by_names` | AppleScript to query macOS Contacts |
| `messaging.rs` | `send_message`, `send_to_group`, `SendResult` | AppleScript to send iMessages |
| `models.rs` | `Message`, `Contact`, `FetchedContact`, `Chat`, `Handle` | Data structures |
| `utils.rs` | `normalize_phone`, `normalize_email`, `apple_to_unix` | Utility functions |

### ChatReader

Opens `~/Library/Messages/chat.db` in **read-only** mode:
- `get_all_chats()` → list of conversations sorted by last message date
- `get_chat_messages(chat_id, limit)` → messages for a conversation
- `get_all_handles()` → phone/email identifiers
- `get_chat_handles(chat_id)` → participants in a conversation

Handles Apple's `attributedBody` blob parsing for modern message formats.

### AppDb

Manages `~/.prm/prm.db`:
- `init_schema()` → creates `contacts` table
- `upsert_contacts(contacts)` → batch insert/update contacts
- `get_all_contacts()` → retrieve all stored contacts

---

## Backend (FastAPI)

**Location:** `backend/`

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app with REST endpoints |
| `sync_contacts.py` | CLI script to sync macOS Contacts → prm.db |

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations` | List conversations with resolved contact names |
| GET | `/conversations/{id}/messages` | Get messages for a conversation |
| POST | `/conversations/{id}/messages` | Send a message |

### HandleResolver

Builds a normalized phone/email → contact name lookup from `prm.db`. Handles:
- Phone normalization (strips formatting, handles +1 country code)
- Email normalization (lowercase)

### Running

```bash
cd backend && uv run uvicorn main:app --reload
```

---

## Frontend (Electron + React)

**Location:** `frontend/src/`

| Path | Purpose |
|------|---------|
| `main/index.ts` | Electron main process, IPC handlers |
| `preload/index.ts` | Context bridge exposing `window.api` |
| `renderer/src/App.tsx` | Main React component |
| `renderer/src/components/` | UI components |
| `renderer/src/api/client.ts` | API client wrapper |
| `renderer/src/data/types.ts` | TypeScript interfaces |

### IPC Handlers (main process)

| Channel | Action |
|---------|--------|
| `api:getConversations` | Fetch `/conversations` |
| `api:getMessages` | Fetch `/conversations/{id}/messages` |
| `api:sendMessage` | POST `/conversations/{id}/messages` |

### Components

| Component | Description |
|-----------|-------------|
| `ConversationList` | Sidebar with conversation list, search, infinite scroll |
| `MessageThread` | Message bubbles, date dividers, input bar |
| `Avatar` | Contact/group avatar with initials |
| `ThemeToggle` | Light/dark mode switch |

### Running

```bash
cd frontend && npm run dev
```

---

## Data Flow

### Reading Conversations

```
App.tsx useEffect
  → window.api.getConversations()
  → IPC → main process
  → fetch localhost:8000/conversations
  → FastAPI calls core.ChatReader.get_all_chats()
  → Rust reads chat.db (read-only SQLite)
  → HandleResolver resolves names from prm.db
  → JSON response → React state
```

### Sending Messages

```
MessageThread handleSend
  → window.api.sendMessage(chatId, text)
  → IPC → main process
  → POST localhost:8000/conversations/{id}/messages
  → FastAPI determines 1:1 vs group
  → core.send_message() or core.send_to_group()
  → Rust executes AppleScript via Messages.app
```

### Contact Sync

```bash
cd backend && uv run python sync_contacts.py
```

```
sync_contacts.py
  → core.fetch_all_contact_names() (AppleScript)
  → core.fetch_contacts_by_names(batch) (AppleScript)
  → core.AppDb.upsert_contacts() (write to prm.db)
```

---

## Databases

| Database | Location | Access | Purpose |
|----------|----------|--------|---------|
| `chat.db` | `~/Library/Messages/chat.db` | Read-only | Apple's iMessage database |
| `prm.db` | `~/.prm/prm.db` | Read/write | App data (contacts cache) |

### prm.db Schema

```sql
CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    emails TEXT,        -- JSON array
    phones TEXT,        -- JSON array
    company TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

---

## Build & Run

```bash
# 1. Build Rust → Python module
cd core && maturin develop --uv

# 2. Sync contacts (one-time)
cd backend && uv run python sync_contacts.py

# 3. Run backend
cd backend && uv run uvicorn main:app --reload

# 4. Run frontend
cd frontend && npm run dev
```
