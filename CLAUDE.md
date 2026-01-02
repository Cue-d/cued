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
├── docs/                          # Design documents and plans
│   ├── agents.md                  # Architecture overview
│   ├── Plan.md                    # Original implementation plan
│   ├── PlanV2.md                  # Updated implementation roadmap
│   ├── PlanV3.md                  # Current TODOs
│   └── DiscoverabilityLayer.md   # Future semantic search/ML features
│
├── .github/workflows/ci.yml       # CI pipeline
└── README.md                      # Project README
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

```bash
# 1. Build Rust core and install as Python module
cd core && maturin develop --uv

# 2. Sync contacts from Contacts.app (one-time)
cd backend && uv run python sync_contacts.py

# 3. Start the backend API server
cd backend && uv run uvicorn main:app --reload

# 4. Start the Electron frontend (in a separate terminal)
cd frontend && pnpm install && pnpm dev
```

### Verification Commands

```bash
# Verify Rust module is importable
uv run python -c "import core; print('OK')"

# Test backend API
curl http://localhost:8000/conversations

# Run linters
cd core && cargo clippy
cd backend && uv run ruff check .
cd frontend && pnpm lint
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
| GET | `/conversations` | List conversations (paginated, limit/offset) |
| GET | `/conversations/{id}/messages` | Get messages for a conversation |
| POST | `/conversations/{id}/messages` | Send a message |

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
# Development
cd core && maturin develop --uv           # Build Rust with uv
cd backend && uv run uvicorn main:app --reload  # Run API server
cd frontend && pnpm dev                    # Run Electron dev mode

# Linting/Formatting
cd core && cargo fmt && cargo clippy
cd backend && uv run ruff check . && uv run ruff format .
cd frontend && pnpm lint && pnpm format

# Production Build
cd frontend && pnpm build:full            # Full build pipeline
```

## CI/CD

GitHub Actions runs on PRs and pushes to main:
- **Frontend**: ESLint + electron-vite build
- **Backend**: ruff check + format
- **Core**: cargo check + clippy + fmt

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
- Rebuild with: `cd core && maturin develop --uv`
- Ensure you're using `uv run` to execute Python commands

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

### Rust (core)
- `pyo3` - Rust-Python bridge
- `rusqlite` - SQLite bindings
- `chrono` - Date/time handling
- `serde/serde_json` - Serialization

### Python (backend)
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `pyinstaller` - Binary bundling

### Node (frontend)
- `electron` - Desktop framework
- `react` - UI library
- `tailwindcss` - Styling
- `typescript` - Type safety
