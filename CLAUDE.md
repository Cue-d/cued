# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a **macOS-only** local-first personal CRM with an iMessage-style interface. It syncs data from the macOS iMessage database (`chat.db`) to a local app database (`prm.db`) and uses AppleScript for contacts and message sending.

## Architecture

```
Electron (React/TS) ←→ FastAPI (Python) ←→ chat.db / prm.db / Contacts.app
                                ↓
                        prm-llm (Swift)
                        Apple Intelligence
```

- **Frontend**: `frontend/` - Electron + React + TypeScript + Tailwind
- **Backend**: `backend/` - FastAPI server with pure Python database sync
- **LLM**: `llm/` - Swift CLI using AnyLanguageModel for intelligent action generation

## Quick Start

```bash
# Setup (from root)
cd backend && uv sync && cd ../frontend && pnpm install

# Optional: Build LLM CLI for intelligent action generation (requires macOS 26+)
cd ../llm && swift build -c release && cd ..

# Run backend (auto-syncs on first launch)
cd backend && uv run uvicorn main:app --reload

# Run frontend (separate terminal)
cd frontend && pnpm dev
```

Note: Initial sync runs automatically on first launch (syncs chat.db → prm.db, builds FTS5 index, queues embeddings). Subsequent launches verify indexes are up to date.

## Key Files

| Feature                  | Files                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Conversations UI         | `frontend/src/renderer/src/components/ConversationList.tsx`                        |
| Message Thread           | `frontend/src/renderer/src/components/MessageThread.tsx`                           |
| Sync Status              | `frontend/src/renderer/src/components/SyncIndicator.tsx`, `hooks/useSyncStatus.ts` |
| Command Palette (Cmd+K)  | `frontend/src/renderer/src/components/CommandMenu.tsx`                             |
| shadcn UI primitives     | `frontend/src/renderer/src/components/ui/`                                         |
| API client               | `frontend/src/renderer/src/api/client.ts`                                          |
| Backend API              | `backend/main.py`                                                                  |
| Database Models          | `backend/db/models.py`                                                             |
| Database Sync            | `backend/db/sync.py`                                                               |
| App Database             | `backend/db/prm_db.py`                                                             |
| Action Queue             | `backend/routers/actions.py`                                                       |
| Search (FTS5 + Semantic) | `backend/routers/search.py`                                                        |
| EOD Contacts             | `backend/routers/eod.py`                                                           |
| Contacts Service         | `backend/services/macos/contacts.py`                                               |
| Messaging Service        | `backend/services/macos/messaging.py`                                              |
| LLM Client               | `backend/services/actions/llm_client.py`                                           |
| Background Workers       | `backend/workers/`                                                                 |
| LLM CLI (Swift)          | `llm/Sources/prm-llm/`                                                             |

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

### Contacts Sync

| Method | Path                  | Description                                            |
| ------ | --------------------- | ------------------------------------------------------ |
| GET    | `/contacts/status`    | Get contacts sync status (counts, last sync timestamp) |
| POST   | `/contacts/sync`      | Trigger incremental contacts sync (or full if no data) |
| POST   | `/contacts/sync/full` | Force full contacts sync from Apple Contacts           |
| GET    | `/contacts/stats`     | Get contact counts (active, deleted, total)            |

## Keyboard Shortcuts

| Shortcut           | Action               |
| ------------------ | -------------------- |
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Common Issues

| Problem                             | Solution                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| "Error accessing messages database" | Grant Full Disk Access to terminal/IDE                            |
| Contact names not resolving         | Restart backend to trigger full sync, or POST `/sync`             |
| Stale contact names                 | Delete `~/.prm/contacts_cache.json` and restart backend           |

## Testing

| Layer    | Framework                | Command                          |
| -------- | ------------------------ | -------------------------------- |
| Frontend | Vitest + Testing Library | `cd frontend && pnpm test`       |
| Backend  | pytest                   | `cd backend && uv run pytest -v` |

**Run all tests from root:**

```bash
cd backend && uv run pytest -v && cd ../frontend && pnpm test --run
```

## Linting

```bash
# Frontend
cd frontend && pnpm lint && pnpm typecheck

# Backend
cd backend && uv run ruff check . && uv run ruff format .
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

## Background Jobs

### Automatic Initialization

On startup, the backend automatically:

1. **Syncs chat.db → prm.db** (full sync if empty, otherwise incremental)
2. **Ensures FTS5 index** is populated (rebuilds if empty or >10% out of sync)
3. **Queues missing messages** for embedding (only messages without embeddings)

### Generate Unanswered Message Actions

Create actions for messages awaiting response (default: 24h threshold):

```bash
curl -X POST "http://localhost:8000/actions/generate/unanswered?threshold_hours=24"
```

### Scheduled Jobs

The backend runs APScheduler jobs automatically:

- **Unanswered scan**: Every 5 minutes (queues chats for LLM analysis with smart priority)
- **LLM queue processor**: Every 10 seconds (processes one queued chat, rate-limited)
- **EOD contacts**: Daily at 9 PM
- **Embedding processing**: Every 5 minutes (100 messages per batch)

### Chat Priority Scoring

When queuing chats for LLM analysis, priority is calculated using a composite score (0-100):

**Time-Decay Curve** (base 20-80):
| Hours Since | Priority | Rationale |
|-------------|----------|-----------|
| 0-2 | 20 | Too fresh, still in active conversation |
| 2-24 | 40→70 | Ramping up, conversation cooling |
| 24-72 | 80 | Peak urgency zone |
| 72-168 | 80→40 | Declining, getting stale |
| 168+ | 30 | Very old, low priority |

**Contact Importance Boost** (+0 to +25):

- Saved contact (`is_contact=true`): +10
- Has company field: +10
- Has notes field: +5

**Group Chat Penalty** (-15):

- Group chats are deprioritized since others may respond

**Example Scores**:

- Saved contact with company, 48h ago: 80 + 10 + 10 = 100 (max)
- Unknown number, 6h ago: 45 + 0 = 45
- Group chat, 24h ago: 80 - 15 = 65

Priority functions are in `backend/services/actions/priority.py`.
