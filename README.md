# PRM - Personal Relationship Manager

A macOS-only local-first personal CRM with an iMessage-style interface.

## Prerequisites

- **macOS** (required - uses native iMessage database and Contacts.app)
- **Full Disk Access** granted to your terminal/IDE (System Settings → Privacy & Security → Full Disk Access)
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- [pnpm](https://pnpm.io/)
- **For Apple Intelligence features:** macOS 26+ (Tahoe) and Xcode 26+ / Swift 6.0+

## Setup

### 1. Install dependencies

```bash
# Backend (Python)
cd backend && uv sync && cd ..

# Frontend (Electron + React)
cd frontend && pnpm install && cd ..
```

### 2. Build Swift LLM CLI (Optional)

The `prm-llm` CLI uses Apple Intelligence for intelligent action generation. If not built, the backend falls back to heuristic-based action generation.

**Requirements:** macOS 26+ (Tahoe), Xcode 26+ or Swift 6.0+

```bash
cd llm && swift build -c release && cd ..
```

The binary is output to `llm/.build/release/prm-llm`. The backend automatically detects and uses it when available.

### 3. Start the app

The backend automatically syncs from `chat.db` on first launch.

**Terminal 1 - Backend:**

```bash
cd backend && uv run uvicorn main:app --reload
```

**Terminal 2 - Frontend:**

```bash
cd frontend && pnpm dev
```

The app will open at http://localhost:5173 (or in Electron).

### 4. Initialize Search Indexes (First Run)

After the initial sync completes, set up the search indexes:

```bash
# Rebuild FTS5 index for full-text search
curl -X POST http://localhost:8000/search/rebuild

# Queue messages for semantic search embeddings
curl -X POST http://localhost:8000/search/embeddings/queue-all

# Process embeddings (run multiple times until pending: 0)
curl -X POST http://localhost:8000/search/embeddings/process?batch_size=500
curl http://localhost:8000/search/embeddings/stats  # Check progress
```

Note: First embedding call downloads the model (~90MB). Processing ~44K messages takes several minutes.

## Resetting the Database

To completely reset and re-seed the local SQLite database:

```bash
# Delete the database
rm -rf ~/.prm/prm.db ~/.prm/contacts_cache.json

# Restart the backend (will re-sync automatically)
cd backend && uv run uvicorn main:app --reload

# In another terminal, rebuild search indexes
curl -X POST http://localhost:8000/search/rebuild
curl -X POST http://localhost:8000/search/embeddings/queue-all
curl -X POST http://localhost:8000/search/embeddings/process?batch_size=500
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

The backend automatically scans for unanswered messages every 5 minutes and generates EOD actions for new contacts daily at 9 PM.

## Building for Production

Build the complete Electron app with all components bundled:

```bash
cd frontend && pnpm build:full
```

This runs the following in order:

1. `build:llm` - Builds the Swift LLM CLI (requires macOS 26+/Xcode 26+)
2. `build:backend` - Packages the Python backend with PyInstaller
3. `build` + `electron-builder` - Builds and packages the Electron app

The final `.dmg` is output to `frontend/dist/`.

**Note:** If Swift build fails (older macOS), the app still works but uses heuristic-based action generation instead of Apple Intelligence.

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

| Problem                                   | Solution                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| "Error accessing messages database"       | Grant Full Disk Access to your terminal                                       |
| Swift build fails                         | Requires macOS 26+ and Xcode 26+/Swift 6.0+. Backend works without it         |
| Contact names showing as phone numbers    | Restart the backend to trigger a sync                                         |
| "database disk image is malformed" (FTS5) | See CLAUDE.md Manual Processes section to recreate FTS5 table                 |
| Semantic search returns empty             | Run embedding queue-all and process commands (see step 4)                     |

## Architecture

```
Frontend (Electron/React) ←→ Backend (FastAPI/Python) ←→ chat.db / prm.db
                                    ↓
                            prm-llm (Swift CLI)
                            Apple Intelligence
```

- `chat.db` - macOS iMessage database (read-only)
- `prm.db` - App's local database (synced copy with resolved names)
- `prm-llm` - Swift CLI for intelligent action generation (optional, requires macOS 26+)
- Contacts resolved via AppleScript → Contacts.app

See [CLAUDE.md](./CLAUDE.md) for detailed development documentation.
