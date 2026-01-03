# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a **macOS-only** local-first personal CRM with an iMessage-style interface. It syncs data from the macOS iMessage database (`chat.db`) to a local app database (`prm.db`) and uses AppleScript for contacts and message sending.

## Architecture

```
Electron (React/TS) ←→ FastAPI (Python) ←→ Rust Core (PyO3) ←→ chat.db / prm.db / Contacts.app
                                                    ↓
                                            SyncWatcher (Rust thread)
                                            sync_db.py (Python)
```

- **Frontend**: `frontend/` - Electron + React + TypeScript + Tailwind
- **Backend**: `backend/` - FastAPI server + sync orchestration
- **Core**: `core/` - Rust with PyO3 bindings for database operations + background sync

## Quick Start

```bash
# Setup (from root)
cd backend && uv sync && cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml && cd frontend && pnpm install

# Run backend (auto-syncs on first launch)
cd backend && uv run uvicorn main:app --reload

# Run frontend (separate terminal)
cd frontend && pnpm dev
```

Note: Initial sync runs automatically on first launch (syncs chat.db → prm.db). Subsequent launches skip blocking sync if data exists.

## Key Files

| Feature | Files |
|---------|-------|
| Conversations UI | `frontend/src/renderer/src/components/ConversationList.tsx` |
| Message Thread | `frontend/src/renderer/src/components/MessageThread.tsx` |
| Sync Status | `frontend/src/renderer/src/components/SyncIndicator.tsx`, `hooks/useSyncStatus.ts` |
| Command Palette (Cmd+K) | `frontend/src/renderer/src/components/CommandMenu.tsx` |
| shadcn UI primitives | `frontend/src/renderer/src/components/ui/` |
| API client | `frontend/src/renderer/src/api/client.ts` |
| Backend API | `backend/main.py` |
| Full Sync (Python) | `backend/sync_db.py` |
| iMessage reading | `core/src/chat_reader.rs` |
| App DB (prm.db) | `core/src/app_db.rs` |
| Background Sync (Rust) | `core/src/sync_watcher.rs` |
| Message sending | `core/src/messaging.rs` |

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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/chats` | List chats with last message |
| GET | `/chats/{id}/messages` | Get messages (limit param) |
| GET | `/chats/{id}/participants` | Get chat participants |
| POST | `/chats/{id}/messages` | Send message (`{"text": "..."}`) |
| GET | `/sync/status` | Get sync status |
| POST | `/sync` | Trigger manual sync |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal/IDE |
| "Cannot import core" | Run `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` from root |
| Contact names not resolving | Restart backend to trigger full sync, or POST `/sync` |
| Stale contact names | Delete `~/.prm/contacts_cache.json` and restart backend |

## Testing

| Layer | Framework | Command |
|-------|-----------|---------|
| Frontend | Vitest + Testing Library | `cd frontend && pnpm test` |
| Backend | pytest | `cd backend && uv run pytest -v` |
| Core | cargo test | `cd core && cargo test` |

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
