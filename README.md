# PRM - Personal Relationship Manager

A macOS-only local-first personal CRM with an iMessage-style interface.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| macOS | Required | - |
| Node.js | 22+ | `node --version` |
| pnpm | 9+ | `pnpm --version` |
| Python | 3.12+ | `python3 --version` |
| uv | Latest | `uv --version` |
| Swift | 6.0+ | `swift --version` |
| Xcode | 26+ | `xcodebuild -version` |

**System Permissions (grant to your terminal/IDE):**
- **Full Disk Access**: System Settings → Privacy & Security → Full Disk Access
- **Contacts**: System Settings → Privacy & Security → Contacts

## Quick Start

```bash
# Clone the repo
git clone <repo-url>
cd kathmandu

# Install all dependencies (backend + frontend + Swift CLIs)
conductor run setup

# Start development servers
conductor run run
```

The app opens at http://localhost:5173 (or in Electron).

## Conductor Scripts

| Script | Description |
|--------|-------------|
| `conductor run setup` | Install all dependencies (auto-runs on new branch) |
| `conductor run run` | Start backend + frontend in dev mode |
| `conductor run run:backend` | Start only backend |
| `conductor run run:frontend` | Start only frontend |
| `conductor run reset` | Nuke database + reinstall all deps (fresh start) |
| `conductor run test` | Run all tests (backend + frontend) |
| `conductor run lint` | Run linters and type checks |
| `conductor run build` | Build Swift CLIs + Electron app |

## Development Workflow

### Starting Fresh (Switching Branches)

When switching to a branch with potential schema changes:

```bash
conductor run reset
conductor run run
```

### Running Tests

```bash
conductor run test
```

Or individually:
```bash
cd backend && uv run pytest
cd frontend && pnpm test
```

### Linting

```bash
conductor run lint
```

Or individually:
```bash
cd backend && uv run ruff check . && uv run ruff format .
cd frontend && pnpm lint && pnpm typecheck
```

## What Happens on First Launch

On first backend startup, the app automatically:

1. Syncs messages from `chat.db` to the local text cache
2. Syncs contacts from Apple Contacts (if `prm-contacts` CLI is available)
3. Builds the FTS5 full-text search index
4. Queues messages for semantic search embeddings
5. Starts background workers (embedding processor, action scanner, contacts sync, etc.)

Note: The first embedding batch downloads the model (~90MB). Full embedding processing happens in the background.

## Resetting the Database

To completely reset and re-seed the local database:

```bash
conductor run reset
```

Or manually:
```bash
rm -rf ~/.prm/
conductor run run  # Will re-sync and rebuild indexes
```

## Building for Production

Build the complete Electron app with all components bundled:

```bash
conductor run build
```

Or via pnpm:
```bash
cd frontend && pnpm build:full
```

The final `.dmg` is output to `frontend/dist/`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to your terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Swift build fails | Requires macOS 26+ and Xcode 26+. App works without it. |
| Contact names showing as phone numbers | Run `curl -X POST http://localhost:8000/contacts/sync` |
| Semantic search returns empty | Wait for background embedding processor, or `conductor run reset` |

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
