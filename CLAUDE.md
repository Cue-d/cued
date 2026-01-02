# CLAUDE.md - PRM Codebase Documentation

This document provides a comprehensive guide for working with the PRM (Personal Relationship Manager) codebase.

## Project Overview

PRM is a **macOS-only** local-first personal CRM that provides an iMessage-style interface for managing conversations. It directly reads from the macOS iMessage database (`chat.db`) and uses AppleScript for contact resolution and message sending.

### Key Features
- iMessage-style UI with familiar conversation list and message thread
- Real-time message sync via polling
- Contact resolution from macOS Contacts app
- Message sending via AppleScript
- Dark/light theme support
- Local-first architecture (all data stays on your machine)

## Architecture

```
┌─────────────────┐     HTTP/REST      ┌─────────────────┐
│   Electron App  │◀──────────────────▶│    FastAPI      │
│   (React/TS)    │    localhost:8000  │    (Python)     │
└─────────────────┘                    └────────┬────────┘
                                                │ PyO3
                                                ▼
                                       ┌─────────────────┐
                                       │      core       │
                                       │   (Rust/PyO3)   │
                                       └────────┬────────┘
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
                    │    prm.db       │ │    chat.db      │ │   Contacts.app  │
                    │   (App DB)      │ │   (iMessage)    │ │  (AppleScript)  │
                    │   READ-WRITE    │ │   READ-ONLY     │ │                 │
                    └─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Three-Tier Design
1. **Frontend**: Electron + React/TypeScript - UI layer
2. **Backend**: FastAPI (Python) - API and orchestration layer
3. **Core**: Rust with PyO3 bindings - High-performance database operations

## Repository Structure

```
prm/
├── core/                          # Rust crate with PyO3 bindings
│   ├── src/
│   │   ├── lib.rs                 # PyO3 module entry point
│   │   ├── models.rs              # Data structures (Message, Contact, Chat, Handle)
│   │   ├── chat_reader.rs         # iMessage chat.db reader (read-only SQLite)
│   │   ├── app_db.rs              # prm.db management (contacts storage)
│   │   ├── contacts.rs            # AppleScript Contacts.app integration
│   │   ├── messaging.rs           # AppleScript message sending
│   │   └── utils.rs               # Phone/email normalization, timestamp conversion
│   └── Cargo.toml
│
├── backend/                       # FastAPI application
│   ├── main.py                    # REST API endpoints, HandleResolver
│   ├── sync_contacts.py           # Contact sync from Contacts.app to prm.db
│   └── pyproject.toml
│
├── frontend/                      # Electron + React
│   ├── src/
│   │   ├── main/index.ts          # Electron main process, IPC handlers
│   │   ├── preload/index.ts       # Context bridge for secure IPC
│   │   └── renderer/src/
│   │       ├── App.tsx            # Root component, state management
│   │       ├── components/
│   │       │   ├── ConversationList.tsx  # Sidebar with conversations
│   │       │   ├── MessageThread.tsx     # Messages and input
│   │       │   ├── Avatar.tsx            # Contact/group avatars
│   │       │   └── ThemeToggle.tsx       # Dark/light mode
│   │       ├── api/client.ts      # API client wrapper
│   │       └── data/types.ts      # TypeScript interfaces
│   ├── package.json
│   └── electron-builder.yml
│
├── docs/                          # Design documents
│   └── DiscoverabilityLayer.md   # Future semantic search/ML features (not implemented)
│
├── .github/workflows/ci.yml       # CI pipeline
├── conductor.json                 # Conductor workspace setup script
└── README.md                      # Project README (outdated - see CLAUDE.md)
```

## Development Setup

### Prerequisites
- **macOS** (required - uses iMessage and Contacts.app)
- **Full Disk Access** granted to your terminal/IDE
- **Rust** 1.70+ with nightly toolchain (for edition 2024)
- **Python** 3.12+
- **Node.js** 20+
- **pnpm** package manager

### Quick Start

**Conductor setup (recommended):**
The `conductor.json` file defines the canonical setup script. Run from root:
```bash
cd backend && uv sync && cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml && cd frontend && pnpm install
```

**Step-by-step:**
```bash
# 1. Install Python dependencies and create virtual environment
cd backend && uv sync

# 2. Build Rust core and install as Python module (from root directory)
cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml

# 3. Install frontend dependencies
cd frontend && pnpm install

# 4. Sync contacts from Contacts.app (one-time, from backend directory)
cd ../backend && uv run python sync_contacts.py

# 5. Start the backend API server
uv run uvicorn main:app --reload

# 6. Start the Electron frontend (in a separate terminal)
cd frontend && pnpm dev
```

### Verification Commands

```bash
# Verify Rust module is importable (from backend directory)
cd backend && uv run python -c "import core; print('OK')"

# Test backend API (requires server running)
curl http://localhost:8000/conversations

# Run linters (from root directory)
cd core && cargo clippy
cd ../backend && uv run ruff check .
cd ../frontend && pnpm lint
```

## Key Design Decisions

### Database Access Strategy
- **chat.db** (iMessage): Opened **read-only** to avoid locking conflicts with Messages.app
- **prm.db** (App): Stores contacts cache only - no message duplication
- All message data is queried directly from chat.db

### Contact Resolution
- Contacts are synced from Contacts.app via AppleScript into prm.db
- HandleResolver builds a normalized phone/email → contact name lookup
- Phone normalization: digits only (handles +1, formatting)
- Email normalization: lowercase

### Message Sending
- Uses AppleScript to interface with Messages.app
- Separate paths for 1:1 messages (by phone/email) and group chats (by chat identifier)

### Real-Time Updates
- Frontend polls backend every 500ms for message updates
- WebSocket support is planned but not yet implemented

### Timestamp Handling
- iMessage uses Apple epoch (nanoseconds since Jan 1, 2001)
- All API responses convert to Unix timestamps
- Conversion: `unix_ts = (apple_ts / 1_000_000_000) + 978307200`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check - returns `{"message": "PRM API"}` |
| GET | `/conversations` | List conversations (paginated, limit/offset) |
| GET | `/conversations/{id}/messages` | Get messages for a conversation (limit param) |
| POST | `/conversations/{id}/messages` | Send a message (body: `{"text": "..."}`) |
| GET | `/test/normalize-phone/{phone}` | Debug endpoint for phone normalization |

## IPC Channels (Electron)

| Channel | Description |
|---------|-------------|
| `api:getConversations` | Fetch conversation list |
| `api:getMessages` | Fetch messages for a chat |
| `api:sendMessage` | Send a message |

## Database Schemas

### chat.db (iMessage - Read Only)
Key tables: `message`, `chat`, `handle`, `chat_message_join`, `chat_handle_join`

### prm.db (App Database)
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

## Important Files by Feature

### Reading Conversations
- `core/src/chat_reader.rs` - SQLite queries for chat.db
- `core/src/models.rs` - Chat, Message, Handle structs
- `backend/main.py` - `/conversations` endpoint

### Contact Resolution
- `core/src/contacts.rs` - AppleScript contact fetching
- `core/src/app_db.rs` - prm.db contact storage
- `backend/sync_contacts.py` - Sync orchestration
- `backend/main.py` - HandleResolver class

### Message Sending
- `core/src/messaging.rs` - AppleScript send functions
- `backend/main.py` - POST `/conversations/{id}/messages`

### UI Components
- `frontend/src/renderer/src/components/ConversationList.tsx` - Sidebar
- `frontend/src/renderer/src/components/MessageThread.tsx` - Chat view
- `frontend/src/renderer/src/components/Avatar.tsx` - Avatars

## Build Commands

```bash
# Development (from root directory)
VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml  # Build Rust
cd backend && uv run uvicorn main:app --reload  # Run API server
cd frontend && pnpm dev                          # Run Electron dev mode

# Linting/Formatting
cd core && cargo fmt && cargo clippy
cd ../backend && uv run ruff check . && uv run ruff format .
cd ../frontend && pnpm lint && pnpm format

# Production Build
cd frontend && pnpm build:full            # Full build pipeline
```

### Frontend Scripts (package.json)

| Script | Description |
|--------|-------------|
| `pnpm dev` | Development mode with hot reload |
| `pnpm build` | TypeScript check + electron-vite build |
| `pnpm lint` | ESLint check |
| `pnpm format` | Prettier formatting |
| `pnpm typecheck` | Full TypeScript type checking |
| `pnpm build:full` | Complete: Rust + Backend + Frontend + macOS package |
| `pnpm build:mac` | Build for macOS only |
| `pnpm build:rust` | Build Rust core (maturin release) |
| `pnpm build:backend` | Build Python backend (pyinstaller) |

## CI/CD

GitHub Actions runs on PRs and pushes to main (`.github/workflows/ci.yml`):

| Job | Steps |
|-----|-------|
| **Frontend** | pnpm install → lint → electron-vite build |
| **Backend** | uv sync --dev → ruff check → ruff format --check |
| **Core** | cargo check → clippy (warnings as errors) → rustfmt --check |

Notes:
- Frontend uses Node.js 20, pnpm 10
- Backend uses Python 3.12, uv
- Core uses Rust nightly (for edition 2024)

## Paths and Locations

| Resource | Path |
|----------|------|
| iMessage DB | `~/Library/Messages/chat.db` |
| App DB | `~/.prm/prm.db` |
| Backend API | `http://localhost:8000` |
| Contacts Cache | `~/.prm/cache/` |

## Common Issues

### "Error accessing messages database"
- Ensure Full Disk Access is granted to your terminal/IDE
- Verify chat.db exists: `ls ~/Library/Messages/chat.db`

### "Cannot import core"
- Rebuild with: `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` (from root directory)
- Ensure you're using `uv run` from the `backend` directory to execute Python commands

### Messages not showing text
- Modern iMessages store text in `attributedBody` blob, not `text` column
- The Rust core handles this parsing automatically

### Contact names not resolving
- Run contact sync: `cd backend && uv run python sync_contacts.py`
- Check prm.db has contacts: `sqlite3 ~/.prm/prm.db "SELECT COUNT(*) FROM contacts"`

## Future Features (from docs/DiscoverabilityLayer.md)
- Semantic search with embeddings (sqlite-vec)
- Relationship scoring and decay tracking
- Smart reminders for unanswered messages
- Auto group chat suggestions via community detection

## Dependencies

### Rust (core/Cargo.toml)
| Crate | Version | Purpose |
|-------|---------|---------|
| `pyo3` | 0.27.2 | Rust-Python bridge (extension-module) |
| `rusqlite` | 0.37.0 | SQLite bindings (bundled) |
| `serde` | 1.0.228 | Serialization (derive) |
| `serde_json` | 1.0.148 | JSON serialization |
| `chrono` | 0.4.42 | **UNUSED** - can be removed |
| `plist` | 1.8.0 | **UNUSED** - can be removed |

### Python (backend/pyproject.toml)
| Package | Version | Purpose |
|---------|---------|---------|
| `fastapi` | >=0.128.0 | Web framework |
| `uvicorn[standard]` | >=0.40.0 | ASGI server |
| `pyinstaller` | >=6.17.0 | Binary bundling |
| `ruff` | >=0.11.0 | Linter/formatter (dev) |

### Node (frontend/package.json)
| Package | Version | Purpose |
|---------|---------|---------|
| `electron` | ^39.2.6 | Desktop framework |
| `react` | ^19.2.1 | UI library |
| `tailwindcss` | ^4.1.18 | Styling |
| `typescript` | ^5.9.3 | Type safety |
| `electron-vite` | ^5.0.0 | Build tool |
| `lucide-react` | ^0.562.0 | Icon library |
| `clsx` | ^2.1.1 | Conditional classnames |
| `tailwind-merge` | ^3.4.0 | Tailwind class merging |

## PyO3 Exports (Rust → Python)

### Data Classes
| Class | Source | Properties |
|-------|--------|------------|
| `Message` | models.rs | rowid, text, date, is_from_me, is_read, date_read, handle_id, chat_id |
| `Contact` | models.rs | id, name, emails, phones, company, notes, created_at, updated_at |
| `FetchedContact` | models.rs | name, emails (Vec), phones (Vec), company, notes |
| `Chat` | models.rs | rowid, chat_identifier, display_name, is_group, last_message_date, last_message_text |
| `Handle` | models.rs | rowid, id, service |
| `SendResult` | messaging.rs | success, error, recipient |

### Database Classes
| Class | Source | Methods |
|-------|--------|---------|
| `ChatReader` | chat_reader.rs | `open(path)`, `count_messages()`, `get_recent_messages(limit)`, `get_all_chats()`, `get_all_handles()`, `get_chat_handles(chat_id)`, `get_chat_messages(chat_id, limit)` |
| `AppDb` | app_db.rs | `open(path)`, `init_schema()`, `upsert_contacts(contacts)`, `get_all_contacts()`, `contact_count()` |

### Functions
| Function | Source | Purpose |
|----------|--------|---------|
| `normalize_phone(phone)` | utils.rs | Strip non-numeric chars |
| `normalize_email(email)` | utils.rs | Lowercase email |
| `apple_to_unix(timestamp)` | utils.rs | Convert Apple epoch to Unix |
| `fetch_all_contact_names()` | contacts.rs | Get names from Contacts.app |
| `fetch_contacts_by_names(names)` | contacts.rs | Get full contact details |
| `send_message(recipient, text)` | messaging.rs | Send 1:1 iMessage |
| `send_to_group(chat_id, text)` | messaging.rs | Send group iMessage |

## React Components

| Component | File | Purpose |
|-----------|------|---------|
| `App` | App.tsx | Root component, state management, polling |
| `ConversationList` | components/ConversationList.tsx | Sidebar with infinite scroll |
| `MessageThread` | components/MessageThread.tsx | Chat view with message bubbles |
| `Avatar` | components/Avatar.tsx | Contact/group avatars with initials |
| `ThemeToggle` | components/ThemeToggle.tsx | Dark/light mode switch |

## Known Issues & Limitations

### Frontend
- **Search not implemented**: UI present but no filtering logic
- **New message button non-functional**: SquarePen button has no handler
- **Polling aggressive**: 500ms interval (could be reduced for production)
- **No virtual scrolling**: All messages rendered (may lag with large histories)
- **Unread status**: Shows indicator but doesn't mark as read on view

### Core (Rust)
- **Unused dependencies**: `chrono` and `plist` crates are imported but never used
- **Unused method**: `get_recent_messages()` exists but is not called by the app (app uses `get_chat_messages()` which works correctly)

### General
- **No WebSocket**: Real-time updates use polling, not WebSocket
- **No message deletion/editing**: Not supported
- **No attachments**: Images, links, etc. not yet implemented

## Documentation Status

**CLAUDE.md** (this file) is the canonical, up-to-date documentation.

| File | Status | Notes |
|------|--------|-------|
| `CLAUDE.md` | Current | Canonical source of truth |
| `README.md` | **Outdated** | Wrong structure, non-existent features (WebSocket, scripts/) |
| `docs/DiscoverabilityLayer.md` | Future | Planned features not yet implemented |

### Key Discrepancies in README.md:
- Claims WebSocket support (actual: polling at 500ms)
- Wrong repo structure (`chat_db.rs` vs `chat_reader.rs`, mentions non-existent files)
- Wrong backend structure (claims `app/main.py`, `cli.py` that don't exist)
- Wrong Python version (claims 3.11+, actual 3.12+)
- Wrong API paths (`/api/conversations` vs `/conversations`)
- Wrong backend run command (`app.main:app` vs `main:app`)
