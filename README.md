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

### 3. Initialize Search Indexes

After the first sync completes, set up the search indexes:

```bash
# Start the backend first
cd backend && uv run uvicorn main:app --reload

# In another terminal, rebuild FTS5 index for full-text search
curl -X POST http://localhost:8000/search/rebuild

# Queue messages for semantic search embeddings
curl -X POST http://localhost:8000/search/embeddings/queue-all

# Process embeddings (run multiple times until pending: 0)
curl -X POST http://localhost:8000/search/embeddings/process?batch_size=500
curl http://localhost:8000/search/embeddings/stats  # Check progress
```

Note: First embedding call downloads the model (~90MB). Processing ~44K messages takes several minutes.

### 4. Start the app

**Terminal 1 - Backend:**
```bash
cd backend && uv run uvicorn main:app --reload
```

**Terminal 2 - Frontend:**
```bash
cd frontend && pnpm dev
```

The app will open at http://localhost:5173 (or in Electron).

## Resetting the Database

To completely reset and re-seed the local SQLite database:

```bash
# Delete the database and contacts cache
rm -rf ~/.prm/prm.db ~/.prm/contacts_cache.json

# Re-run the full sync (~10 minutes)
cd backend && uv run python sync_db.py

# Start the backend
uv run uvicorn main:app --reload

# In another terminal, rebuild search indexes
curl -X POST http://localhost:8000/search/rebuild
curl -X POST http://localhost:8000/search/embeddings/queue-all
curl -X POST http://localhost:8000/search/embeddings/process?batch_size=500
```

## Refreshing Contacts

If contact names become stale or you've added new contacts:

```bash
# Delete cache and re-sync
rm ~/.prm/contacts_cache.json
cd backend && uv run python sync_db.py
```

## Action Queue

PRM includes a Tinder-style action queue for managing unanswered messages and new contacts:

```bash
# Generate actions for unanswered messages (24h+ old)
curl -X POST "http://localhost:8000/actions/generate/unanswered?threshold_hours=24"

# View pending actions
curl http://localhost:8000/actions/

# Swipe actions: left=discard, up=snooze, right=complete
curl -X POST http://localhost:8000/actions/1/swipe -H "Content-Type: application/json" -d '{"direction": "right", "response_text": "Hey!"}'
```

The backend automatically scans for unanswered messages every 6 hours and generates EOD actions for new contacts daily at 9 PM.

## Running Tests

**Backend (pytest):**
```bash
cd backend && uv run pytest
```

**Frontend (vitest):**
```bash
cd frontend && pnpm test
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to your terminal |
| "Cannot import core" | Run `VIRTUAL_ENV=backend/.venv maturin develop --manifest-path core/Cargo.toml` |
| Contact names showing as phone numbers | Run the initial sync: `cd backend && uv run python sync_db.py` |
| Sync seems stuck | Contact resolution is slow (~10 min) - this is normal |
| "database disk image is malformed" (FTS5) | See CLAUDE.md Manual Processes section to recreate FTS5 table |
| Semantic search returns empty | Run embedding queue-all and process commands (see step 3) |

## Architecture

```
Frontend (Electron/React) ←→ Backend (FastAPI) ←→ Core (Rust/PyO3) ←→ chat.db / prm.db
```

- `chat.db` - macOS iMessage database (read-only)
- `prm.db` - App's local database (synced copy with resolved names)
- Contacts resolved via AppleScript → Contacts.app

See [CLAUDE.md](./CLAUDE.md) for detailed development documentation.
