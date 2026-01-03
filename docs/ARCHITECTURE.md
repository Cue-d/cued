# PRM Architecture Reference

This document contains detailed architectural information about the PRM codebase. For quick-start guidance, see [CLAUDE.md](../CLAUDE.md).

## Project Overview

PRM is a **macOS-only** local-first personal CRM that provides an iMessage-style interface for managing conversations. It syncs data from the macOS iMessage database (`chat.db`) to a local app database (`prm.db`) and uses AppleScript for contact resolution and message sending.

### Key Features
- iMessage-style UI with familiar conversation list and message thread
- Real-time message sync via background Rust watcher (500ms polling)
- Data mirrored from chat.db to prm.db (source of truth)
- Contact resolution from macOS Contacts app with caching
- Message sending via AppleScript
- Dark/light theme support
- Command palette (Cmd+K) for quick actions and conversation search
- Local-first architecture (all data stays on your machine)
- Sync status indicator in UI

## Architecture Diagram

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

### Sync Architecture
The app mirrors data from chat.db (iMessage) to prm.db (app database) for:
- Pre-computed display names and contact resolution
- Faster queries (no runtime contact lookups)
- Extensibility (can add app-specific metadata)

Two sync mechanisms work together:
1. **Full Sync** (`sync_db.py`): Python-based sync for people, chats, and bulk data
2. **Background Watcher** (`SyncWatcher`): Rust background thread for near-real-time message/attachment sync (polls every 500ms)

## Repository Structure

```
prm/
├── core/                          # Rust crate with PyO3 bindings
│   ├── src/
│   │   ├── lib.rs                 # PyO3 module entry point
│   │   ├── models.rs              # Data structures (Person, PrmChat, PrmMessage, SyncMessage, etc.)
│   │   ├── chat_reader.rs         # iMessage chat.db reader (read-only SQLite)
│   │   ├── app_db.rs              # prm.db management (people, chats, messages, attachments)
│   │   ├── sync_watcher.rs        # Background sync watcher (Rust thread, 500ms polling)
│   │   ├── contacts.rs            # AppleScript Contacts.app integration
│   │   ├── messaging.rs           # AppleScript message sending
│   │   └── utils.rs               # Phone/email normalization, timestamp conversion, text extraction
│   └── Cargo.toml
│
├── backend/                       # FastAPI application
│   ├── main.py                    # FastAPI app entry point, sync status, lifespan
│   ├── sync_db.py                 # Full sync from chat.db to prm.db (people, chats, messages)
│   ├── routers/
│   │   └── chats.py               # Chat endpoints (renamed from conversations.py)
│   ├── schemas.py                 # Pydantic response models
│   ├── tests/
│   │   ├── conftest.py            # Test fixtures (mocked AppDb, etc.)
│   │   └── test_api.py            # API endpoint tests
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
│   │       │   ├── SyncIndicator.tsx     # Sync status indicator
│   │       │   ├── Avatar.tsx            # Contact/group avatars
│   │       │   ├── ThemeToggle.tsx       # Dark/light mode
│   │       │   ├── CommandMenu.tsx       # Cmd+K command palette
│   │       │   └── ui/                   # shadcn/ui components
│   │       │       ├── command.tsx       # Command palette primitives
│   │       │       └── dialog.tsx        # Dialog primitives
│   │       ├── hooks/
│   │       │   ├── index.ts              # Hook exports
│   │       │   ├── useChats.ts           # Chat data hook with background sync trigger
│   │       │   └── useSyncStatus.ts      # Sync status polling hook
│   │       ├── __tests__/         # Vitest tests
│   │       │   ├── setup.ts             # Test setup (jest-dom)
│   │       │   ├── Avatar.test.tsx      # Avatar component tests
│   │       │   ├── ThemeToggle.test.tsx # ThemeToggle component tests
│   │       │   └── utils.test.ts        # Utility function tests
│   │       ├── api/client.ts      # API client wrapper
│   │       └── data/types.ts      # TypeScript interfaces
│   ├── vitest.config.ts           # Vitest configuration
│   ├── package.json
│   └── electron-builder.yml
│
├── docs/                          # Design documents
│   ├── ARCHITECTURE.md            # This file
│   └── DiscoverabilityLayer.md    # Future semantic search/ML features (not implemented)
│
├── .github/workflows/ci.yml       # CI pipeline
├── conductor.json                 # Conductor workspace setup script
├── CLAUDE.md                      # Quick-start guide for AI assistants
└── README.md                      # Project README (outdated)
```

## Development Setup

### Prerequisites
- **macOS** (required - uses iMessage and Contacts.app)
- **Full Disk Access** granted to your terminal/IDE
- **Rust** 1.70+ with nightly toolchain (for edition 2024)
- **Python** 3.12+
- **Node.js** 20+
- **pnpm** package manager

### Step-by-step Setup

```bash
# 1. Install Python dependencies and create virtual environment
cd backend && uv sync

# 2. Build Rust core and install as Python module (from root directory)
cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml

# 3. Install frontend dependencies
cd frontend && pnpm install

# 4. Start the backend API server (auto-syncs on first launch)
cd ../backend && uv run uvicorn main:app --reload

# 5. Start the Electron frontend (in a separate terminal)
cd frontend && pnpm dev
```

Note: Initial sync happens automatically on first launch. The backend syncs data from chat.db → prm.db (people, chats, messages). Subsequent launches skip blocking sync if data exists.

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
- **prm.db** (App): Source of truth - stores synced people, chats, messages, attachments
- All API queries read from prm.db for fast, pre-resolved data
- Sync copies data from chat.db → prm.db with contact resolution at sync time

### Contact Resolution
- Contacts are fetched from Contacts.app via AppleScript and cached in `~/.prm/contacts_cache.json` (1-hour TTL)
- Names are resolved during sync and stored in prm.db's `people` table
- Phone normalization: digits only (handles +1, formatting)
- Email normalization: lowercase
- Display names are pre-computed for chats (group: "Soham, Aaron, Jay +2")

### Message Sending
- Uses AppleScript to interface with Messages.app
- Separate paths for 1:1 messages (by phone/email) and group chats (by chat identifier)

### Real-Time Updates
- **Rust Background Watcher**: Polls chat.db every 500ms for new messages/attachments
- **Python Full Sync**: Runs on startup and can be triggered manually
- Frontend polls backend for updates (chat list refresh)

### Timestamp Handling
- iMessage uses Apple epoch (nanoseconds since Jan 1, 2001)
- All API responses convert to Unix timestamps
- Conversion: `unix_ts = (apple_ts / 1_000_000_000) + 978307200`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check - returns `{"message": "PRM API"}` |
| GET | `/chats` | List chats with last message (from prm.db) |
| GET | `/chats/{id}/messages` | Get messages for a chat (limit param) |
| GET | `/chats/{id}/participants` | Get participants for a chat |
| POST | `/chats/{id}/messages` | Send a message (body: `{"text": "..."}`) |
| GET | `/sync/status` | Get current sync status (is_syncing, initial_sync_complete, etc.) |
| POST | `/sync` | Manually trigger a full sync |
| GET | `/test/normalize-phone/{phone}` | Debug endpoint for phone normalization |

## IPC Channels (Electron)

| Channel | Description |
|---------|-------------|
| `api:getChats` | Fetch chat list |
| `api:getMessages` | Fetch messages for a chat |
| `api:sendMessage` | Send a message |
| `api:getSyncStatus` | Get sync status |

## Database Schemas

### chat.db (iMessage - Read Only)
Key tables: `message`, `chat`, `handle`, `chat_message_join`, `chat_handle_join`

### prm.db (App Database - Source of Truth)
```sql
-- People: Merged handles + contacts (one row per identifier+service)
CREATE TABLE people (
    id INTEGER PRIMARY KEY,          -- Same as handle.ROWID
    identifier TEXT NOT NULL,        -- phone "+12025551234" or email
    name TEXT NOT NULL,              -- resolved name (contact name or fallback)
    short_name TEXT,                 -- first name for group display
    service TEXT NOT NULL,           -- iMessage, SMS
    is_contact INTEGER NOT NULL,     -- has Apple Contacts entry
    contact_phones TEXT,             -- JSON array of all phones
    contact_emails TEXT,             -- JSON array of all emails
    company TEXT,
    notes TEXT,
    synced_at INTEGER NOT NULL,
    UNIQUE(identifier, service)
);

-- Chats: Conversations
CREATE TABLE chats (
    id INTEGER PRIMARY KEY,          -- Same as chat.ROWID
    identifier TEXT NOT NULL,        -- phone/email for 1:1, "chat123" for groups
    display_name TEXT,               -- user-set name (groups only)
    computed_name TEXT,              -- pre-computed display name
    is_group INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
);

-- Chat participants (many-to-many)
CREATE TABLE chat_participants (
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    PRIMARY KEY (chat_id, person_id)
);

-- Messages: Pre-resolved sender
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,          -- Same as message.ROWID
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    sender_id INTEGER REFERENCES people(id),  -- NULL if is_from_me
    text TEXT,
    timestamp INTEGER NOT NULL,      -- Unix timestamp
    is_from_me INTEGER NOT NULL,
    is_read INTEGER NOT NULL,
    read_at INTEGER,                 -- Unix timestamp
    has_attachments INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL
);

-- Attachments: Metadata only
CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,          -- Same as attachment.ROWID
    message_id INTEGER NOT NULL REFERENCES messages(id),
    filename TEXT,
    path TEXT,                       -- full path in ~/Library/Messages/Attachments
    mime_type TEXT,
    uti TEXT,                        -- uniform type identifier
    size INTEGER,                    -- bytes
    is_outgoing INTEGER NOT NULL,
    created_at INTEGER,              -- Unix timestamp
    synced_at INTEGER NOT NULL
);

-- Sync state tracking
CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
-- Keys: 'last_message_rowid', 'last_attachment_rowid'
```

## Paths and Locations

| Resource | Path |
|----------|------|
| iMessage DB | `~/Library/Messages/chat.db` |
| App DB | `~/.prm/prm.db` |
| Contacts Cache | `~/.prm/contacts_cache.json` |
| Backend API | `http://localhost:8000` |

## Dependencies

### Rust (core/Cargo.toml)
| Crate | Version | Purpose |
|-------|---------|---------|
| `pyo3` | 0.27.2 | Rust-Python bridge (auto-initialize for tests, extension-module for builds) |
| `rusqlite` | 0.37.0 | SQLite bindings (bundled) |
| `serde` | 1.0.228 | Serialization (derive) |
| `serde_json` | 1.0.148 | JSON serialization |
| `chrono` | 0.4.42 | **UNUSED** - can be removed |
| `plist` | 1.8.0 | **UNUSED** - can be removed |

#### Feature Flags
- `extension-module`: Enable when building for Python via maturin (don't link libpython)
- Default (no flags): Links to Python, allows `cargo test` to work

### Python (backend/pyproject.toml)
| Package | Version | Purpose |
|---------|---------|---------|
| `fastapi` | >=0.128.0 | Web framework |
| `uvicorn[standard]` | >=0.40.0 | ASGI server |
| `pyinstaller` | >=6.17.0 | Binary bundling |
| `ruff` | >=0.11.0 | Linter/formatter (dev) |
| `pytest` | >=9.0.0 | Testing framework (dev) |
| `httpx` | >=0.28.0 | HTTP client for tests (dev) |
| `pytest-asyncio` | >=1.3.0 | Async test support (dev) |

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
| `cmdk` | ^1.1.1 | Command palette library |
| `@radix-ui/react-dialog` | ^1.1.15 | Accessible dialog primitives |
| `vitest` | ^4.0.16 | Test runner (dev) |
| `@testing-library/react` | ^16.3.1 | React testing utilities (dev) |
| `@testing-library/jest-dom` | ^6.9.1 | DOM matchers (dev) |
| `jsdom` | ^27.4.0 | DOM environment for tests (dev) |

## PyO3 Exports (Rust → Python)

### Data Classes (prm.db models)
| Class | Source | Properties |
|-------|--------|------------|
| `Person` | models.rs | id, identifier, name, short_name, service, is_contact, contact_phones, contact_emails, company, notes |
| `PrmChat` | models.rs | id, identifier, display_name, computed_name, is_group, last_message_text, last_message_timestamp |
| `PrmMessage` | models.rs | id, chat_id, sender_id, sender_name, text, timestamp, is_from_me, is_read, read_at, has_attachments |
| `Attachment` | models.rs | id, message_id, filename, path, mime_type, uti, size, is_outgoing, created_at |

### Sync Models (for chat.db → prm.db transfer)
| Class | Source | Properties |
|-------|--------|------------|
| `SyncHandle` | models.rs | id, identifier, service |
| `SyncChat` | models.rs | id, identifier, display_name, is_group |
| `SyncMessage` | models.rs | id, chat_id, handle_id, text, timestamp, is_from_me, is_read, read_at, has_attachments |
| `SyncAttachment` | models.rs | id, message_id, filename, path, mime_type, uti, size, is_outgoing, created_at |

### Legacy Models (backward compatibility)
| Class | Source | Properties |
|-------|--------|------------|
| `Message` | models.rs | rowid, text, date, is_from_me, is_read, date_read, handle_id, chat_id |
| `SendResult` | messaging.rs | success, error, recipient |

### Database Classes
| Class | Source | Methods |
|-------|--------|---------|
| `ChatReader` | chat_reader.rs | `open(path)`, `get_all_chats_for_sync()`, `get_all_handles_for_sync()`, `get_chat_participants_for_sync()`, `get_messages_since(rowid, limit)`, `get_attachments_since(rowid, limit)` |
| `AppDb` | app_db.rs | `open(path)`, `init_schema()`, `upsert_person(...)`, `upsert_chat(...)`, `insert_messages(...)`, `insert_attachments(...)`, `get_all_chats()`, `get_chat_messages(chat_id, limit)`, `get_chat_participants(chat_id)`, `get_sync_state(key)`, `set_sync_state(key, value)` |
| `SyncWatcher` | sync_watcher.rs | `new()`, `start(chat_db_path, app_db_path)`, `stop()`, `is_running()` |

### Functions
| Function | Source | Purpose |
|----------|--------|---------|
| `normalize_phone(phone)` | utils.rs | Strip non-numeric chars |
| `normalize_email(email)` | utils.rs | Lowercase email |
| `apple_to_unix(timestamp)` | utils.rs | Convert Apple epoch to Unix |
| `extract_text_from_attributed_body(blob)` | utils.rs | Extract text from NSAttributedString blob |
| `fetch_all_contact_names()` | contacts.rs | Get names from Contacts.app |
| `fetch_contacts_by_names(names)` | contacts.rs | Get full contact details |
| `send_message(recipient, text)` | messaging.rs | Send 1:1 iMessage |
| `send_to_group(chat_id, text)` | messaging.rs | Send group iMessage |

## React Components

| Component | File | Purpose |
|-----------|------|---------|
| `App` | App.tsx | Root component, state management, sync status |
| `ConversationList` | components/ConversationList.tsx | Sidebar with infinite scroll |
| `MessageThread` | components/MessageThread.tsx | Chat view with message bubbles |
| `SyncIndicator` | components/SyncIndicator.tsx | Animated sync status indicator |
| `Avatar` | components/Avatar.tsx | Contact/group avatars with initials |
| `ThemeToggle` | components/ThemeToggle.tsx | Dark/light mode switch |
| `CommandMenu` | components/CommandMenu.tsx | Cmd+K command palette |

### Custom Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useChats` | hooks/useChats.ts | Fetch chats, trigger background sync |
| `useSyncStatus` | hooks/useSyncStatus.ts | Poll sync status, track initial sync completion |

### shadcn/ui Components

The project uses [shadcn/ui](https://ui.shadcn.com/) for reusable UI primitives. Components are in `frontend/src/renderer/src/components/ui/`.

**Configuration:** `frontend/components.json` defines shadcn settings:
- Style: `new-york`
- CSS variables enabled
- Path aliases configured for Electron structure

**Adding new components:**
```bash
cd frontend && pnpm dlx shadcn@latest add [component-name] --yes
```

Note: After adding, verify imports use `@/` aliases (shadcn may generate full paths).

| Component | File | Purpose |
|-----------|------|---------|
| `Command` | ui/command.tsx | Command palette using cmdk |
| `Dialog` | ui/dialog.tsx | Modal dialog using Radix UI |

## Build Commands

```bash
# Development (from root directory)
VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml --features extension-module  # Build Rust for Python
cd backend && uv run uvicorn main:app --reload  # Run API server
cd frontend && pnpm dev                          # Run Electron dev mode

# Testing
cd core && cargo test                            # Run Rust unit tests (26 tests)
cd backend && uv run pytest -v                   # Run backend tests
cd frontend && pnpm test                         # Run frontend tests

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
| `pnpm test` | Run vitest tests |
| `pnpm build` | TypeScript check + electron-vite build |
| `pnpm lint` | ESLint check |
| `pnpm format` | Prettier formatting |
| `pnpm typecheck` | Full TypeScript type checking |
| `pnpm build:full` | Complete: Rust + Backend + Frontend + macOS package |
| `pnpm build:mac` | Build for macOS only |
| `pnpm build:rust` | Build Rust core (maturin release) |
| `pnpm build:backend` | Build Python backend (pyinstaller) |

## Testing

### Quick Reference

| Layer | Framework | Command | Test Count |
|-------|-----------|---------|------------|
| **Core** | cargo test | `cd core && cargo test` | 26 tests |
| **Backend** | pytest | `cd backend && uv run pytest -v` | - |
| **Frontend** | Vitest + Testing Library | `cd frontend && pnpm test --run` | 10 tests |

**Run all tests from root:**
```bash
cd core && cargo test && cd ../backend && uv run pytest -v && cd ../frontend && pnpm test --run
```

---

### Rust Core Tests

26 unit tests organized by module:

| Module | Tests | Coverage |
|--------|-------|----------|
| `utils.rs` | 11 | Phone/email normalization, timestamp conversion |
| `chat_reader.rs` | 11 | Length decoding, text extraction, in-memory SQLite queries |
| `app_db.rs` | 4 | Contact CRUD operations with in-memory SQLite |

**PyO3 Testing Strategy:**
- `auto-initialize` feature enables Python interpreter in tests
- `extension-module` feature is only used for maturin builds (prevents libpython linking)
- Tests use in-memory SQLite to avoid filesystem dependencies
- Private functions (`decode_length`, `extract_text_from_attributed_body`) tested directly via inline test modules

---

### Backend Tests (pytest)

**Configuration:** `backend/tests/conftest.py`
- Mocked `ChatReader` for deterministic test data
- `HandleResolver` with empty contacts for isolated testing
- Uses `TestClient` from FastAPI for endpoint testing

**Test Files:**
| File | Coverage |
|------|----------|
| `test_api.py` | API endpoint tests (`/conversations`, `/conversations/{id}/messages`) |

---

### Frontend Tests (Vitest)

**Configuration:** `frontend/vitest.config.ts`
- Environment: `jsdom` for DOM simulation
- Setup file: `__tests__/setup.ts` (imports `@testing-library/jest-dom`)
- Path alias: `@/` resolves to `src/renderer/src/`
- Test pattern: `src/renderer/src/**/*.test.{ts,tsx}`

**Test Files:**
| File | Tests | Coverage |
|------|-------|----------|
| `Avatar.test.tsx` | 4 | Initials, fallback, sizes, group avatars |
| `ThemeToggle.test.tsx` | 3 | Icon rendering, click handler |
| `utils.test.ts` | 3 | `cn()` utility class merging |

**Watch vs Single Run:**
```bash
cd frontend && pnpm test        # Watch mode (development)
cd frontend && pnpm test --run  # Single run (CI)
```

## CI/CD

GitHub Actions runs on PRs and pushes to main (`.github/workflows/ci.yml`):

| Job | Steps |
|-----|-------|
| **Frontend** | pnpm install → lint → electron-vite build |
| **Backend** | uv sync --dev → ruff check → ruff format --check → pytest |
| **Core** | cargo check → clippy (warnings as errors) → rustfmt --check |

Notes:
- Frontend uses Node.js 20, pnpm 10
- Backend uses Python 3.12, uv
- Core uses Rust nightly (for edition 2024)

## Known Issues & Limitations

### Frontend
- **Search not implemented**: UI present but no filtering logic (use Cmd+K for conversation search)
- **New message button non-functional**: SquarePen button has no handler
- **No virtual scrolling**: All messages rendered (may lag with large histories)
- **Unread status**: Shows indicator but doesn't mark as read on view

### Core (Rust)
- **Unused dependencies**: `chrono` and `plist` crates are imported but never used
- **Crate naming**: Named `core` which shadows Rust's std `core` - doctests disabled to avoid conflicts

### Sync
- **FK constraints disabled in watcher**: Background watcher disables FK constraints to avoid errors when messages arrive for chats not yet synced
- **Contacts cache TTL**: 1-hour cache may show stale contact names until next full sync

### General
- **No WebSocket**: Real-time updates use polling, not WebSocket
- **No message deletion/editing**: Not supported
- **Attachments metadata only**: Attachment records are synced but display is not yet implemented

## Future Features (from docs/DiscoverabilityLayer.md)
- Semantic search with embeddings (sqlite-vec)
- Relationship scoring and decay tracking
- Smart reminders for unanswered messages
- Auto group chat suggestions via community detection
