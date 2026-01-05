# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a **macOS-only** local-first personal CRM with an iMessage-style interface. It syncs data from the macOS iMessage database (`chat.db`) to a local app database (`prm.db`) and uses AppleScript for contacts and message sending.

## Architecture

```
Electron (React/TS) ←→ FastAPI (Python) ←→ Rust Core (PyO3) ←→ chat.db / prm.db / Contacts.app
                                ↓                   ↓
                        prm-llm (Swift)     SyncWatcher (Rust thread)
                        Apple Intelligence   sync_db.py (Python)
```

- **Frontend**: `frontend/` - Electron + React + TypeScript + Tailwind
- **Backend**: `backend/` - FastAPI server + sync orchestration
- **Core**: `core/` - Rust with PyO3 bindings for database operations + background sync
- **LLM**: `llm/` - Swift CLI using AnyLanguageModel for intelligent action generation

## Quick Start

```bash
# Setup (from root)
cd backend && uv sync && cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml && cd frontend && pnpm install

# Optional: Build LLM CLI for intelligent action generation (requires macOS 26+)
cd ../llm && swift build -c release && cd ..

# Run backend (auto-syncs on first launch)
cd backend && uv run uvicorn main:app --reload

# Run frontend (separate terminal)
cd frontend && pnpm dev
```

Note: Initial sync runs automatically on first launch (syncs chat.db → prm.db). Subsequent launches skip blocking sync if data exists.

## Key Files

| Feature                  | Files                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------------------------- |
| Conversations UI         | `frontend/src/renderer/src/components/ConversationList.tsx`                        |
| Message Thread           | `frontend/src/renderer/src/components/MessageThread.tsx`                           |
| Sync Status              | `frontend/src/renderer/src/components/SyncIndicator.tsx`, `hooks/useSyncStatus.ts` |
| Command Palette (Cmd+K)  | `frontend/src/renderer/src/components/CommandMenu.tsx`                             |
| shadcn UI primitives     | `frontend/src/renderer/src/components/ui/`                                         |
| API client               | `frontend/src/renderer/src/api/client.ts`                                          |
| Backend API              | `backend/main.py`                                                                  |
| Full Sync (Python)       | `backend/sync_db.py`                                                               |
| iMessage reading         | `core/src/chat_reader.rs`                                                          |
| App DB (prm.db)          | `core/src/app_db.rs`                                                               |
| Background Sync (Rust)   | `core/src/sync_watcher.rs`                                                         |
| Message sending          | `core/src/messaging.rs`                                                            |
| Action Queue             | `backend/routers/actions.py`                                                       |
| Search (FTS5 + Semantic) | `backend/routers/search.py`                                                        |
| EOD Contacts             | `backend/routers/eod.py`                                                           |
| Embedding Worker         | `backend/embedding_worker.py`                                                      |
|                          | LLM Client                                                                         | `backend/services/llm_client.py` |
|                          | LLM CLI (Swift)                                                                    | `llm/Sources/prm-llm/`           |

## Behaviors

### DO

- Use `@/` path aliases for imports in frontend
- Run `pnpm lint && pnpm typecheck` before committing frontend changes
- Use `pnpm dlx shadcn@latest add [component] --yes` to add new UI components
- After adding shadcn components, verify imports use `@/` aliases (CLI may generate full paths)
- Open chat.db as **read-only** to avoid locking conflicts with Messages.app

### DON'T

- Don't modify chat.db directly - it's read-only
- Don't use `"use client"` directive - this is Electron, not Next.js
- Don't add unused dependencies to Cargo.toml (`chrono` and `plist` are already unused)

## API Endpoints

### Core Endpoints

| Method | Path                       | Description                      |
| ------ | -------------------------- | -------------------------------- |
| GET    | `/chats`                   | List chats with last message     |
| GET    | `/chats/{id}/messages`     | Get messages (limit param)       |
| GET    | `/chats/{id}/participants` | Get chat participants            |
| POST   | `/chats/{id}/messages`     | Send message (`{"text": "..."}`) |
| GET    | `/sync/status`             | Get sync status                  |
| POST   | `/sync`                    | Trigger manual sync              |

### Action Queue (Swipeable Cards)

| Method | Path                           | Description                                            |
| ------ | ------------------------------ | ------------------------------------------------------ |
| GET    | `/actions/`                    | List pending actions                                   |
| GET    | `/actions/{id}`                | Get single action with context                         |
| POST   | `/actions/`                    | Create new action                                      |
| POST   | `/actions/{id}/swipe`          | Swipe action (left=discard, up=snooze, right=complete) |
| DELETE | `/actions/{id}`                | Delete action                                          |
| POST   | `/actions/generate/unanswered` | Generate actions for unanswered messages               |

### Search

| Method | Path                           | Description                      |
| ------ | ------------------------------ | -------------------------------- |
| GET    | `/search/?query=`              | Full-text search (FTS5)          |
| GET    | `/search/semantic?query=`      | Semantic search (embeddings)     |
| POST   | `/search/rebuild`              | Rebuild FTS5 index               |
| POST   | `/search/embeddings/queue-all` | Queue all messages for embedding |
| POST   | `/search/embeddings/process`   | Process embedding queue          |
| GET    | `/search/embeddings/stats`     | Get embedding queue stats        |

### End-of-Day (EOD)

| Method | Path                         | Description                           |
| ------ | ---------------------------- | ------------------------------------- |
| GET    | `/eod/contacts`              | Get today's new contacts              |
| POST   | `/eod/generate`              | Generate EOD actions for new contacts |
| POST   | `/eod/contacts/{id}/context` | Add context/notes to a person         |

## Keyboard Shortcuts

| Shortcut           | Action               |
| ------------------ | -------------------- |
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Common Issues

| Problem                             | Solution                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| "Error accessing messages database" | Grant Full Disk Access to terminal/IDE                                                    |
| "Cannot import core"                | Run `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` from root |
| Contact names not resolving         | Restart backend to trigger full sync, or POST `/sync`                                     |
| Stale contact names                 | Delete `~/.prm/contacts_cache.json` and restart backend                                   |

## Testing

| Layer    | Framework                | Command                          |
| -------- | ------------------------ | -------------------------------- |
| Frontend | Vitest + Testing Library | `cd frontend && pnpm test`       |
| Backend  | pytest                   | `cd backend && uv run pytest -v` |
| Core     | cargo test               | `cd core && cargo test`          |

**Run all tests from root:**

```bash
cd core && cargo test && cd ../backend && uv run pytest -v && cd ../frontend && pnpm test --run
```

## Linting

```bash
# Frontend
cd frontend && pnpm lint && pnpm typecheck

# Backend
cd backend && uv run ruff check . && uv run ruff format .

# Core
cd core && cargo clippy && cargo fmt
```

## Building Core for Python

```bash
# For testing (links to Python)
cargo test

# For maturin/Python module (uses extension-module feature)
VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml --features extension-module
```

## Building LLM CLI (Swift)

The `prm-llm` CLI uses Apple Intelligence (Foundation Models) via AnyLanguageModel for intelligent action generation.

```bash
# Build release binary
cd llm && swift build -c release

# Binary location: llm/.build/release/prm-llm
```

**Requirements:**

- macOS 26.0+ (Tahoe) for Apple Intelligence support
- Xcode 26+ or Swift 6.0+

If the LLM binary is unavailable, the backend falls back to heuristic-based action generation.

## Manual Processes

### Initial FTS5 Search Index Setup

After first sync, rebuild the FTS5 index for full-text search:

```bash
curl -X POST http://localhost:8000/search/rebuild
```

If FTS5 index becomes corrupted ("database disk image is malformed"), manually recreate:

```python
# Run from backend directory
import sqlite3
conn = sqlite3.connect(os.path.expanduser("~/.prm/prm.db"))
cursor = conn.cursor()
cursor.execute('DROP TABLE IF EXISTS messages_fts')
cursor.execute('''CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content='messages', content_rowid='id')''')
cursor.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
conn.commit()
```

### Initial Embedding Setup (Semantic Search)

Queue all messages for embedding, then process in batches:

```bash
# Queue all messages (~44K typically)
curl -X POST http://localhost:8000/search/embeddings/queue-all

# Process in batches (each batch processes ~100 messages)
curl -X POST http://localhost:8000/search/embeddings/process?batch_size=500

# Check progress
curl http://localhost:8000/search/embeddings/stats
```

Note: First call downloads the model (~90MB). Processing is CPU-intensive; run multiple times until `pending: 0`.

### Generate Unanswered Message Actions

Create actions for messages awaiting response (default: 24h threshold):

```bash
curl -X POST "http://localhost:8000/actions/generate/unanswered?threshold_hours=24"
```

### Background Scheduler

The backend runs APScheduler jobs automatically:

- **Unanswered scan**: Every 6 hours (uses LLM for intelligent action type/priority if available, falls back to heuristics)
- **EOD contacts**: Daily at 9 PM
- **Embedding processing**: Every 5 minutes (100 messages per batch)
