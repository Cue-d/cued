# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a **macOS-only** local-first personal CRM with an iMessage-style interface. It reads directly from the macOS iMessage database (`chat.db`) and uses AppleScript for contacts and message sending.

## Architecture

```
Electron (React/TS) ←→ FastAPI (Python) ←→ Rust Core (PyO3) ←→ chat.db / prm.db / Contacts.app
```

- **Frontend**: `frontend/` - Electron + React + TypeScript + Tailwind
- **Backend**: `backend/` - FastAPI server
- **Core**: `core/` - Rust with PyO3 bindings for database operations

## Quick Start

```bash
# Setup (from root)
cd backend && uv sync && cd .. && VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml && cd frontend && pnpm install

# Run backend
cd backend && uv run uvicorn main:app --reload

# Run frontend (separate terminal)
cd frontend && pnpm dev
```

## Key Files

| Feature | Files |
|---------|-------|
| Conversations UI | `frontend/src/renderer/src/components/ConversationList.tsx` |
| Message Thread | `frontend/src/renderer/src/components/MessageThread.tsx` |
| Command Palette (Cmd+K) | `frontend/src/renderer/src/components/CommandMenu.tsx` |
| shadcn UI primitives | `frontend/src/renderer/src/components/ui/` |
| API client | `frontend/src/renderer/src/api/client.ts` |
| Backend API | `backend/main.py` |
| iMessage reading | `core/src/chat_reader.rs` |
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
| GET | `/conversations` | List conversations (limit/offset) |
| GET | `/conversations/{id}/messages` | Get messages (limit param) |
| POST | `/conversations/{id}/messages` | Send message (`{"text": "..."}`) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal/IDE |
| "Cannot import core" | Run `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` from root |
| Contact names not resolving | Run `cd backend && uv run python sync_contacts.py` |

## Linting

```bash
# Frontend
cd frontend && pnpm lint && pnpm typecheck

# Backend
cd backend && uv run ruff check . && uv run ruff format .

# Core
cd core && cargo clippy && cargo fmt
```
