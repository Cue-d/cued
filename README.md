# PRM - Personal Relationship Manager

A local-first personal CRM designed to level up the way you manage and iterate on relationships. PRM provides an iMessage-like interface with powerful augmentations including a Cmd+K command bar, filters, actions, and AI-powered text generation.

## Overview

PRM is an Electron application with a FastAPI + Rust backend that directly integrates with your iMessage database to provide:

- **iMessage-style UI**: Familiar interface that evokes the same feeling as Messages.app
- **Real-time sync**: Near-instantaneous message updates via WebSocket
- **Contact resolution**: Smart phone/email matching with your macOS Contacts
- **Fast search**: Rust-powered SQLite queries for instant message search
- **Local-first**: All data stays on your machine
- **Extensible metadata**: Tag conversations, track relationship metrics, add custom notes

## Architecture

```
┌─────────────────┐     WebSocket/REST     ┌─────────────────┐
│   Electron App  │◀──────────────────────▶│    FastAPI      │
│   (TypeScript)  │                        │    (Python)     │
└─────────────────┘                        └────────┬────────┘
                                                    │ PyO3
                                                    ▼
                                           ┌─────────────────┐
                                           │      core       │
                                           │   (Rust/PyO3)   │
                                           └────────┬────────┘
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                     ▼                     ▼
                    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
                    │    prm.db       │   │    chat.db      │   │   Contacts      │
                    │   (App DB)      │   │   (iMessage)    │   │  (AppleScript)  │
                    └─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Components

- **core** (Rust): High-performance database operations, message parsing, and sync engine
- **backend** (FastAPI): REST and WebSocket API layer, contact hydration
- **frontend**: iMessage-style UI with React/Svelte
- **prm.db**: Local app database for contacts, conversations, and metadata

## Repository Structure

```
prm/
├── core/               # Rust crate with PyO3 bindings
│   ├── src/
│   │   ├── lib.rs      # PyO3 module entry
│   │   ├── app_db.rs   # prm.db management
│   │   ├── chat_db.rs  # iMessage chat.db reader
│   │   ├── models.rs   # Data structures
│   │   ├── sync.rs     # Sync engine
│   │   └── errors.rs   # Error types
│   └── Cargo.toml
│
├── backend/            # FastAPI application
│   ├── app/
│   │   ├── main.py     # FastAPI app entry
│   │   ├── config.py   # Configuration
│   │   ├── api/        # REST & WebSocket routes
│   │   └── services/   # Business logic
│   ├── cli.py          # CLI commands
│   └── pyproject.toml
│
├── frontend/           # Electron + React/Svelte
│   ├── src/
│   │   ├── main/       # Electron main process
│   │   ├── preload/    # Preload scripts
│   │   └── renderer/   # React/Svelte UI
│   └── electron-builder.yml
│
├── scripts/            # Build & utility scripts
└── docs/               # Documentation
```

## Prerequisites

- **macOS** (required for iMessage and Contacts integration)
- **Rust** 1.70+ (`rustup` toolchain)
- **Python** 3.11+
- **Node.js** 18+
- **Full Disk Access** granted to your terminal/IDE

### Installation

1. **Install Rust**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Install uv and maturin**:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   uv tool install maturin
   ```

3. **Install Node.js** (via Homebrew):
   ```bash
   brew install node
   ```

4. **Grant Full Disk Access**:
   - Open System Preferences → Security & Privacy → Privacy → Full Disk Access
   - Add your terminal application (Terminal.app, iTerm2, or your IDE)

## Development Setup

### 1. Build Rust Core

```bash
cd core
maturin develop --uv  # Builds and installs with uv
```

Verify the build:
```bash
uv run python -c "import core; print('OK')"
```

### 2. Run Backend

```bash
cd backend
uv venv
uv add fastapi uvicorn websockets
uv add --editable ../core
uv run uvicorn app.main:app --reload
```

Test the API:
```bash
curl http://localhost:8000/api/conversations
```

### 3. Run Electron App

```bash
cd frontend
npm install
npm run dev
```

## Key Features

### Message Database Access

PRM reads from `~/Library/Messages/chat.db` using a Rust-powered SQLite interface for high-performance queries. The Rust layer handles:

- Apple timestamp conversion (nanoseconds since 2001-01-01)
- `attributedBody` blob parsing for modern message formats
- Group chat detection and participant resolution
- Incremental sync to avoid reading the entire database on each update

### Contact Resolution

Uses AppleScript to hydrate contacts from macOS Contacts app, then builds a normalized index for O(1) lookups:

- Phone number normalization (handles +1, formatting, etc.)
- Email normalization (case-insensitive)
- Multiple identifiers per contact support

### Real-Time Updates

WebSocket connection between Electron and FastAPI enables near-instantaneous message updates. The backend watches `chat.db` for changes and broadcasts updates to all connected clients.

### Unified App Database

`prm.db` stores:
- **Contacts**: Cached from macOS Contacts with custom fields (tags, relationship score, custom notes)
- **Conversations**: Metadata for each chat (pinned, muted, tags, unread count)
- **Messages Cache**: For fast full-text search
- **Sync State**: Cursor tracking for incremental sync

## Usage

### Development Commands

```bash
# Build Rust and install to Python venv
cd prm-core && maturin develop

# Run FastAPI backend
cd backend && uvicorn app.main:app --reload

# Run Electron in dev mode
cd electron-app && npm run dev

# Hydrate contacts from macOS Contacts
cd backend && python -m cli hydrate-contacts

# Test WebSocket connection
websocat ws://localhost:8000/ws
```

### Production Build

```bash
# Full build pipeline (creates packaged .app)
./scripts/build.sh
```

The build script:
1. Builds Rust crate with `maturin build --release`
2. Bundles Python backend with PyInstaller
3. Copies bundled backend to Electron resources
4. Builds Electron app with electron-builder

## Future Features

- **On-device fine-tuning**: MLX-powered text generation in your own style
- **Bulk messaging**: Draft and send messages en masse
- **Relationship metrics**: Track meaningful contact frequency
- **Advanced filters**: Smart filters by contact, date range, content
- **Message sending**: Full support for sending via advanced-imessage-kit port

## Database Schema

### contacts
- Contact information from macOS Contacts
- Custom fields: tags, relationship_score, custom_notes, last_meaningful_contact

### identifier_index
- Normalized phone/email lookups
- Foreign key to contacts table

### conversations
- Chat metadata: display_name, participants, tags, last_message
- UI state: is_pinned, is_muted, unread_count

### messages_cache
- Full-text search index
- Linked to conversations via foreign key

## Troubleshooting

### "Error accessing messages database"
- Ensure Full Disk Access is granted to your terminal/IDE
- Check that `~/Library/Messages/chat.db` exists

### "SQLITE_BUSY" errors
- The Rust layer opens `chat.db` in read-only mode
- SQLite busy timeout is set to 5000ms
- Ensure iMessage app is not exclusively locking the database

### "Cannot import prm_core"
- Rebuild with `cd prm-core && maturin develop`
- Ensure your Python venv is activated

### WebSocket disconnections
- Check FastAPI server is running
- Verify no firewall is blocking localhost:8000
- Check browser/Electron console for connection errors

## Contributing

Contributions are welcome! Areas of focus:

- Performance optimization for large message histories (10k+ messages)
- Group chat support improvements
- Message sending via minimal Photon Kit port
- UI polish to match iMessage more closely

## License

[MIT License](LICENSE)

## Acknowledgments

- [advanced-imessage-kit](https://github.com/photon-hq/advanced-imessage-kit) for inspiration on message sending
- [PyO3](https://pyo3.rs/) for Rust-Python interop
- [Maturin](https://www.maturin.rs/) for building and publishing Rust Python packages

---

**Note**: This project is for personal use and requires macOS. It directly reads the iMessage database, which is a personal data store. Use responsibly and ensure you have proper backups.
