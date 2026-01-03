# PRM Architecture Reference

This document contains detailed architectural information about the PRM codebase. For quick-start guidance, see [CLAUDE.md](../CLAUDE.md).

## Project Overview

PRM is a **macOS-only** local-first personal CRM that provides an iMessage-style interface for managing conversations. It directly reads from the macOS iMessage database (`chat.db`) and uses AppleScript for contact resolution and message sending.

### Key Features
- iMessage-style UI with familiar conversation list and message thread
- Real-time message sync via polling
- Contact resolution from macOS Contacts app
- Message sending via AppleScript
- Dark/light theme support
- Command palette (Cmd+K) for quick actions and conversation search
- Local-first architecture (all data stays on your machine)

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
│   ├── main.py                    # FastAPI app entry point
│   ├── routers/
│   │   └── conversations.py       # Conversation endpoints
│   ├── schemas.py                 # Pydantic response models
│   ├── services.py                # HandleResolver for contact resolution
│   ├── sync_contacts.py           # Contact sync from Contacts.app to prm.db
│   ├── tests/
│   │   ├── conftest.py            # Test fixtures (mocked ChatReader, etc.)
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
│   │       │   ├── Avatar.tsx            # Contact/group avatars
│   │       │   ├── ThemeToggle.tsx       # Dark/light mode
│   │       │   ├── CommandMenu.tsx       # Cmd+K command palette
│   │       │   └── ui/                   # shadcn/ui components
│   │       │       ├── command.tsx       # Command palette primitives
│   │       │       └── dialog.tsx        # Dialog primitives
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

## Paths and Locations

| Resource | Path |
|----------|------|
| iMessage DB | `~/Library/Messages/chat.db` |
| App DB | `~/.prm/prm.db` |
| Backend API | `http://localhost:8000` |
| Contacts Cache | `~/.prm/cache/` |

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
| `CommandMenu` | components/CommandMenu.tsx | Cmd+K command palette |

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

### Rust Core Tests

The Rust core has 26 unit tests covering:

| Module | Tests | Description |
|--------|-------|-------------|
| `utils.rs` | 11 | Phone/email normalization, timestamp conversion |
| `chat_reader.rs` | 11 | Length decoding, text extraction, in-memory SQLite queries |
| `app_db.rs` | 4 | Contact CRUD operations with in-memory SQLite |

Run tests:
```bash
cd core && cargo test
```

**PyO3 Testing Strategy:**
- `auto-initialize` feature enables Python interpreter in tests
- `extension-module` feature is only used for maturin builds (prevents libpython linking)
- Tests use in-memory SQLite to avoid filesystem dependencies
- Private functions (`decode_length`, `extract_text_from_attributed_body`) tested directly via inline test modules

### Frontend (Vitest)

The frontend uses [Vitest](https://vitest.dev/) with [Testing Library](https://testing-library.com/) for component testing.

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

**Running Tests:**
```bash
cd frontend && pnpm test        # Watch mode
cd frontend && pnpm test --run  # Single run
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
- **Polling aggressive**: 500ms interval (could be reduced for production)
- **No virtual scrolling**: All messages rendered (may lag with large histories)
- **Unread status**: Shows indicator but doesn't mark as read on view

### Core (Rust)
- **Unused dependencies**: `chrono` and `plist` crates are imported but never used
- **Unused method**: `get_recent_messages()` exists but is not called by the app
- **Crate naming**: Named `core` which shadows Rust's std `core` - doctests disabled to avoid conflicts

### General
- **No WebSocket**: Real-time updates use polling, not WebSocket
- **No message deletion/editing**: Not supported
- **No attachments**: Images, links, etc. not yet implemented

## Future Features (from docs/DiscoverabilityLayer.md)
- Semantic search with embeddings (sqlite-vec)
- Relationship scoring and decay tracking
- Smart reminders for unanswered messages
- Auto group chat suggestions via community detection
