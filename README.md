# PRM - Personal Relationship Manager

A macOS-only local-first personal CRM with an iMessage-style interface.

## Prerequisites

- **macOS** (required - uses native iMessage database and Contacts.app)
- **Full Disk Access** granted to your terminal/IDE (System Settings → Privacy & Security → Full Disk Access)
- **Contacts Access** granted to your terminal/IDE (System Settings → Privacy & Security → Contacts)
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

### 2. Build Swift CLIs

Two Swift CLIs are available:

**prm-contacts** (Recommended) - Fast contacts sync via Contacts.framework (~100x faster than AppleScript):

```bash
cd llm && swift build -c release --product prm-contacts && cd ..
```

**prm-llm** (Optional) - Apple Intelligence for intelligent action generation. If not built, the backend falls back to heuristic-based action generation. Requires macOS 26+ (Tahoe):

```bash
cd llm && swift build -c release --product prm-llm && cd ..
```

Or build both at once:

```bash
cd llm && swift build -c release && cd ..
```

Binaries are output to `llm/.build/release/`. The backend automatically detects and uses them when available.

### 3. Start the app

**Terminal 1 - Backend:**

```bash
cd backend && uv run uvicorn main:app --reload --reload-exclude .venv
```

**Terminal 2 - Frontend:**

```bash
cd frontend && pnpm dev
```

The app will open at http://localhost:5173 (or in Electron).

On first launch, the backend automatically:

1. Syncs messages from `chat.db` to the local text cache
2. Syncs contacts from Apple Contacts (if `prm-contacts` CLI is available)
3. Builds the FTS5 full-text search index
4. Queues messages for semantic search embeddings
5. Starts background workers (embedding processor, action scanner, contacts sync, etc.)

Note: The first embedding batch downloads the model (~90MB). Full embedding processing happens in the background.

## Resetting the Database

To completely reset and re-seed the local SQLite database:

```bash
# Delete the databases
rm -rf ~/.prm/

# Restart the backend (will re-sync and rebuild indexes automatically)
cd backend && uv run uvicorn main:app --reload --reload-exclude .venv
```

## Action Queue

PRM includes a Tinder-style action queue for managing unanswered messages:

```bash
# Generate actions for unanswered messages (24h+ old)
curl -X POST "http://localhost:8000/actions/generate/unanswered?threshold_hours=24"

# View pending actions
curl http://localhost:8000/actions/

# Swipe actions: left=discard, up=snooze, right=complete
curl -X POST http://localhost:8000/actions/1/swipe -H "Content-Type: application/json" -d '{"direction": "right", "response_text": "Hey!"}'
```

The backend automatically scans for unanswered messages every 5 minutes.

## Building for Production

Build the complete Electron app with all components bundled:

```bash
cd frontend && pnpm build:full
```

This runs the following in order:

1. `build:llm` - Builds both Swift CLIs (prm-contacts and prm-llm)
2. `build:backend` - Packages the Python backend with PyInstaller
3. `build` + `electron-builder` - Builds and packages the Electron app

The final `.dmg` is output to `frontend/dist/`.

**Note:** If Swift build fails (older macOS), the app still works but uses heuristic-based action generation and slower AppleScript contacts sync.

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

| Problem                                | Solution                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| "Error accessing messages database"    | Grant Full Disk Access to your terminal                               |
| "Contacts access denied"               | Grant Contacts access to your terminal in System Settings             |
| Swift build fails                      | Requires macOS 26+ and Xcode 26+/Swift 6.0+. Backend works without it |
| Contact names showing as phone numbers | Run `curl -X POST http://localhost:8000/contacts/sync`                |
| Semantic search returns empty          | Wait for background embedding processor, or reset database            |

## Architecture

```
Frontend (Electron/React) ←→ Backend (FastAPI/Python) ←→ chat.db / prm.db
                                    ↓
                            Swift CLIs (optional)
                            - prm-contacts (Contacts.framework)
                            - prm-llm (Apple Intelligence)
```

- `chat.db` - macOS iMessage database (read-only)
- `prm.db` - App's local database (synced copy with resolved names)
- `prm-contacts` - Swift CLI for fast contacts sync (optional, recommended)
- `prm-llm` - Swift CLI for intelligent action generation (optional, requires macOS 26+)

See [CLAUDE.md](./CLAUDE.md) for detailed development documentation.
