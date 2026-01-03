# PRM - Personal Relationship Manager

A macOS-only local-first personal CRM with an iMessage-style interface.

## Prerequisites

- **macOS** (required - uses native iMessage database and Contacts.app)
- **Full Disk Access** granted to your terminal/IDE (System Settings → Privacy & Security → Full Disk Access)
- [Rust](https://rustup.rs/)
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- [pnpm](https://pnpm.io/)

## Setup

### 1. Install dependencies

```bash
# Install maturin (Rust → Python build tool)
uv tool install maturin

# Backend (Python)
cd backend && uv sync && cd ..

# Core (Rust → Python bindings)
VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml

# Frontend (Electron + React)
cd frontend && pnpm install && cd ..
```

### 2. Run initial sync (~10 minutes)

The first sync fetches all your iMessage history and resolves contact names via AppleScript. This takes approximately 10 minutes due to Contacts.app API limitations.

```bash
cd backend && uv run python sync_db.py
```

You'll see progress output as it syncs:
- People (handles from chat.db)
- Chats (conversations)
- Messages (incremental batches)
- Attachments

### 3. Start the app

**Terminal 1 - Backend:**
```bash
cd backend && uv run uvicorn main:app --reload
```

**Terminal 2 - Frontend:**
```bash
cd frontend && pnpm dev
```

The app will open at http://localhost:5173 (or in Electron).

## Refreshing Contacts

If contact names become stale or you've added new contacts:

```bash
# Delete cache and re-sync
rm ~/.prm/contacts_cache.json
cd backend && uv run python sync_db.py
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to your terminal |
| "Cannot import core" | Run `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` |
| Contact names showing as phone numbers | Run the initial sync: `cd backend && uv run python sync_db.py` |
| Sync seems stuck | Contact resolution is slow (~10 min) - this is normal |

## Architecture

```
Frontend (Electron/React) ←→ Backend (FastAPI) ←→ Core (Rust/PyO3) ←→ chat.db / prm.db
```

- `chat.db` - macOS iMessage database (read-only)
- `prm.db` - App's local database (synced copy with resolved names)
- Contacts resolved via AppleScript → Contacts.app

See [CLAUDE.md](./CLAUDE.md) for detailed development documentation.
