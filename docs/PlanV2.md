# PRM (Personal Relationship Manager) - Implementation Plan v2

## Overview

A local-first Electron app mimicking iMessage's UI, backed by a FastAPI + Rust stack. Features real-time message sync, contact resolution, and a unified app database for metadata extensibility.

**Architecture:**
```
┌─────────────────┐     WebSocket/REST     ┌─────────────────┐
│   Electron App  │◀──────────────────────▶│    FastAPI      │
│   (TypeScript)  │                        │    (Python)     │
└─────────────────┘                        └────────┬────────┘
                                                    │ PyO3
                                                    ▼
                                           ┌─────────────────┐
                                           │   core      │
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

---

## Phase 1: Project Scaffolding

### 1.1 Repository Structure
- [ ] Create the monorepo directory structure:
  ```
  prm/
  ├── core/           # Rust crate (PyO3)
  ├── backend/            # FastAPI application
  ├── frontend/       # Electron + React/Svelte
  ├── scripts/            # Build & utility scripts
  └── docs/               # Documentation
  ```
- [x] Initialize git repository
- [x] Create `.gitignore` for Rust, Python, Node artifacts
- [x] Create root `README.md` with project overview

### 1.2 Development Environment
- [x] Ensure Rust toolchain is installed (`rustup`)
- [x] Ensure Python 3.11+ is available
- [x] Ensure Node.js 18+ is installed
- [x] Install `uv` package manager: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [x] Install `maturin` globally: `uv tool install maturin`
- [x] Create Python virtual environment for backend: `cd backend && uv venv`
- [x] Verify Full Disk Access is granted to your terminal/IDE

---

## Phase 2: Rust Core Library (core)

### 2.1 Level 0: Pure Rust Utilities
- [x] Initialize Rust crate: `cargo new --lib core`
- [x] Add `chrono` dependency to `Cargo.toml`
- [x] Create `src/apple_time.rs`:
  - Write `apple_to_unix(apple_timestamp)` function
  - Apple epoch is 978307200 seconds after Unix epoch
  - Handle nanoseconds conversion
- [x] Write tests for `apple_time` with various timestamps
- [x] Create `src/normalize.rs`:
  - Write `normalize_phone(phone)` - strip formatting, handle +1 prefix
  - Write `normalize_email(email)` - lowercase
- [x] Write comprehensive tests for phone/email normalization
- [x] Run `cargo test` - verify all tests pass

NOTE, consolidated both apple_time and normalize into a utils.rs

### 2.2 Level 1: Read from chat.db
- [x] Add `rusqlite` with `bundled` feature to dependencies
- [x] Create `src/chat_reader.rs`:
  - Define `ChatReader` struct with SQLite connection
  - Implement `open(path)` using `SQLITE_OPEN_READ_ONLY` flag
  - Implement `count_messages()` method
- [x] Write test using real chat.db at `/Users/[YOU]/Library/Messages/chat.db`
- [x] Test should verify message count > 0
- [x] Run `cargo test` - confirm reading from real iMessage database works

### 2.3 Level 2: Extract message structs
- [x] Add `serde` with `derive` feature to dependencies
- [x] Create `src/models.rs`:
  - Define `Message` struct: rowid, text (Option), date, is_from_me
  - Add `#[derive(Debug, Clone, serde::Serialize)]`
- [x] In `chat_reader.rs`, add `get_recent_messages(limit)`:
  - Query: SELECT ROWID, text, date, is_from_me FROM message ORDER BY date DESC LIMIT ?
  - Use `query_map` to convert rows to Message structs
- [x] Write test that fetches 10 recent messages and prints them
- [x] Run test - verify actual iMessages are extracted and displayed

### 2.4 Level 3: Create prm.db and write data
- [ ] Create `src/app_db.rs`:
  - Define `AppDb` struct with SQLite connection
  - Implement `open(path)` in read-write mode
  - Implement `init_schema()` creating `messages_cache` table (rowid, text, date, is_from_me)
- [ ] Add `insert_message(&Message)` method using INSERT OR REPLACE
- [ ] Write test that:
  - Reads 5 messages from real chat.db
  - Creates in-memory AppDb using `:memory:` path
  - Inserts messages into AppDb
  - Verifies count matches
- [ ] Run test - confirm basic sync flow works

### 2.5 Level 4: Contact resolution with normalization
- [ ] Extend `app_db.rs` schema with:
  - `contacts` table: id (autoincrement), name
  - `identifiers` table: identifier, normalized, contact_id (FK)
  - Index on normalized column
- [ ] Add `add_contact(name, phone)` method:
  - Insert contact into contacts table
  - Normalize phone using `normalize::normalize_phone()`
  - Insert into identifiers table
- [ ] Add `resolve_phone(phone)` method:
  - Normalize input phone
  - JOIN identifiers to contacts on normalized match
  - Return Option<String> for contact name
- [ ] Write test that:
  - Adds contact "Alice" with "(555) 123-4567"
  - Resolves various formats: "555-123-4567", "+15551234567", "5551234567"
  - Verifies all resolve to "Alice"
  - Verifies unknown number returns None
- [ ] Run test - confirm identifier resolution works

### 2.6 Level 5: Error handling
- [ ] Add `thiserror` dependency
- [ ] Create `src/errors.rs`:
  - Define `CoreError` enum: Database, ChatDbNotFound, InvalidIdentifier
  - Add `#[derive(Error, Debug)]` and `#[error("...")]` attributes
  - Define `Result<T>` type alias
- [ ] Update function signatures to use `crate::errors::Result<T>`
- [ ] Add file existence validation in `ChatReader::open()`
- [ ] Run `cargo test` - confirm error handling works

### 2.7 Level 6: Minimal PyO3 integration
- [ ] Update `Cargo.toml`:
  - Add `crate-type = ["cdylib"]` under `[lib]`
  - Add `pyo3` with `extension-module` feature
- [ ] Create `src/lib.rs`:
  - Import all module files
  - Create `#[pyfunction]` for `normalize_phone`
  - Create `#[pymodule]` function named `core`
- [ ] Build: `cd core && maturin develop --uv`
- [ ] Test: `uv run python -c "import core; print(core.normalize_phone('(555) 123-4567'))"`
- [ ] Verify output is `5551234567`

### 2.8 Level 7: Full PyO3 API
- [ ] Add `serde_json` dependency
- [ ] Create `src/py_bindings.rs`:
  - Define `PyChatReader` class with `#[pyclass]` and `#[pymethods]`
  - Add `open(path)` static method
  - Add `get_recent_messages(limit)` - serialize to JSON strings
  - Define `PyAppDb` class
  - Add `open(path)`, `add_contact(name, phone)`, `resolve_phone(phone)` methods
- [ ] Update `lib.rs` to expose classes with `add_class::<...>()`
- [ ] Build: `maturin develop --uv`
- [ ] Write Python test script:
  - Import core
  - Create PyChatReader, fetch and print messages
  - Create PyAppDb, add contact, resolve phone
- [ ] Verify end-to-end Python integration works

### 2.9 Level 8: Expand data model
- [ ] Expand `Message` struct with: chat_id, sender, attachments
- [ ] Create `Conversation` struct: chat_identifier, display_name, participants
- [ ] Implement `get_all_chats()` in chat_reader.rs
- [ ] Add conversations table to app_db.rs schema
- [ ] Implement conversation sync logic
- [ ] Add tests for new functionality
- [ ] Expose new features in py_bindings.rs
- [ ] Handle `attributedBody` blob parsing for message text extraction
- [ ] Handle group chat detection via `chat_identifier` prefix

### 2.10 Level 9: Advanced features
- [ ] Expand contacts table schema with full fields:
  - phones (JSON), emails (JSON), company, job_title, birthday, notes_apple
  - tags (JSON), relationship_score, custom_notes
  - last_meaningful_contact, source, created_at, updated_at
- [ ] Implement `sync_conversations()`:
  - Read all chats from chat.db
  - Upsert into conversations table
  - Update last_message_preview, last_message_date
- [ ] Implement `sync_messages_incremental(since_rowid)`:
  - Get new messages from chat.db
  - Insert into messages_cache
  - Update parent conversation fields
- [ ] Implement `get_sync_cursor()` and `set_sync_cursor()`
- [ ] Implement `get_latest_message_rowid()` for sync tracking
- [ ] Implement `get_messages_since(rowid)` for incremental sync
- [ ] Implement `get_chat_messages(chat_id, limit, before_rowid)` with pagination
- [ ] Build complete identifier index for multiple phones/emails per contact
- [ ] Expose all functions to Python: `sync_all()`, `get_conversations()`, `get_thread()`, `search_messages()`

---

## Phase 3: Contacts Hydration (Python)

### 3.1 AppleScript Batch Fetcher
- [ ] Create `backend/app/services/contacts.py`
- [ ] Implement `fetch_all_contact_names()` - single AppleScript call
- [ ] Implement `fetch_contacts_batch(names, batch_size=50)` - batched detail fetching
- [ ] Implement `_parse_batch_output(output)` - parse multi-contact AppleScript response
- [ ] Implement parallel batch execution with `ThreadPoolExecutor`

### 3.2 Contacts to App DB
- [ ] Implement `hydrate_contacts_to_db()`:
  - Fetch all contacts via AppleScript
  - Insert/update contacts in prm.db via core
  - Build identifier index
- [ ] Add CLI command: `uv run python -m backend.cli hydrate-contacts`
- [ ] Add progress output during hydration

### 3.3 Contact Resolution Integration
- [ ] Verify `core.resolve_identifier()` works with hydrated data
- [ ] Test resolution with various phone formats (+1, parentheses, dashes)
- [ ] Test resolution with email addresses

---

## Phase 4: FastAPI Backend

### 4.1 Project Setup
- [ ] Initialize FastAPI project in `backend/`: `cd backend && uv init`
- [ ] Add dependencies with uv:
  - `uv add fastapi uvicorn websockets`
  - `uv add --editable ../core` (local path)
- [ ] Create directory structure:
  ```
  backend/
  ├── app/
  │   ├── main.py
  │   ├── config.py
  │   ├── api/
  │   │   ├── routes/
  │   │   │   ├── conversations.py
  │   │   │   ├── messages.py
  │   │   │   ├── contacts.py
  │   │   │   └── websocket.py
  │   │   └── deps.py
  │   └── services/
  │       ├── message_service.py
  │       ├── contact_service.py
  │       └── sync_service.py
  └── cli.py
  ```

### 4.2 Core Services
- [ ] Create `MessageService` wrapping core functions
- [ ] Create `ContactService` for contact operations
- [ ] Create `SyncService` for background sync management
- [ ] Initialize core on app startup (lifespan handler)

### 4.3 REST Endpoints
- [ ] `GET /api/conversations` - list all conversations with previews
- [ ] `GET /api/conversations/{id}` - single conversation details
- [ ] `GET /api/conversations/{id}/messages?limit=50&before=` - paginated thread
- [ ] `GET /api/contacts` - list all contacts
- [ ] `GET /api/contacts/{id}` - single contact details
- [ ] `GET /api/search?q=` - search messages
- [ ] `POST /api/messages` - send a message (placeholder for now)

### 4.4 WebSocket Real-Time Updates
- [ ] Create `ConnectionManager` class for tracking WebSocket connections
- [ ] Implement `/ws` WebSocket endpoint
- [ ] Implement background task that watches for chat.db changes
- [ ] On change detected:
  - Run incremental sync via core
  - Broadcast `new_messages` event to all connected clients
- [ ] Define WebSocket message format:
  ```json
  {"type": "new_messages", "messages": [...]}
  {"type": "conversation_updated", "conversation": {...}}
  ```

### 4.5 Backend Testing
- [ ] Start server: `uv run uvicorn app.main:app --reload`
- [ ] Test REST endpoints with curl or httpie
- [ ] Test WebSocket connection with `websocat` or browser devtools
- [ ] Verify real-time updates when new iMessage arrives

---

## Phase 5: Message Sending (Minimal Photon Port)

### 5.1 AppleScript Send Implementation
- [ ] Create `backend/app/services/sender.py`
- [ ] Implement `send_message(recipient, text)` using AppleScript:
  - Target Messages.app
  - Send to buddy/participant
  - Return success/failure
- [ ] Implement basic rate limiter (8/min per recipient, 25/min global)

### 5.2 Send Confirmation
- [ ] After send, poll chat.db for message appearance (up to 10s timeout)
- [ ] Return confirmation with message rowid/guid if found
- [ ] Return "pending" status if timeout

### 5.3 API Integration
- [ ] Implement `POST /api/messages` endpoint:
  - Accept `{recipient, text}`
  - Call sender service
  - Return send status
- [ ] Broadcast sent message via WebSocket after confirmation

---

## Phase 6: Electron Frontend

### 6.1 Project Initialization
- [ ] Initialize Electron app with React or Svelte
- [ ] Set up electron-builder for packaging
- [ ] Configure TypeScript
- [ ] Set up basic window with frameless/custom titlebar (macOS native feel)
- [ ] Create directory structure:
  ```
  frontend/
  ├── src/
  │   ├── main/           # Electron main process
  │   ├── preload/        # Preload scripts
  │   └── renderer/       # React/Svelte UI
  │       ├── components/
  │       ├── stores/
  │       ├── hooks/
  │       └── styles/
  └── electron-builder.yml
  ```

### 6.2 Backend Process Management
- [ ] In main process, spawn FastAPI backend as child process
- [ ] Wait for backend health check before showing window
- [ ] Handle backend crashes (restart or show error)
- [ ] Kill backend on app quit

### 6.3 API Client Setup
- [ ] Create `api.ts` with REST client (fetch wrapper)
- [ ] Create `socket.ts` with WebSocket client:
  - Auto-reconnect logic
  - Event emitter pattern for message handling
- [ ] Create typed interfaces for API responses

### 6.4 State Management
- [ ] Set up state store (Zustand, Jotai, or Svelte stores)
- [ ] Define state shape:
  ```typescript
  {
    conversations: Conversation[]
    selectedConversationId: string | null
    messages: Record<string, Message[]>  // keyed by conversation id
    contacts: Contact[]
  }
  ```
- [ ] Implement actions: loadConversations, selectConversation, loadMessages, sendMessage

### 6.5 Conversation List Component (Left Sidebar)
- [ ] Create `ConversationList` component
- [ ] Render list of conversations with:
  - Avatar (initials or contact photo placeholder)
  - Contact/group name
  - Last message preview (truncated)
  - Timestamp (relative: "2:34 PM", "Yesterday", "Mon")
  - Unread indicator (bold + count badge)
- [ ] Highlight selected conversation
- [ ] Sort by last_message_date descending
- [ ] On click: select conversation, load messages

### 6.6 Message Thread Component (Center)
- [ ] Create `MessageThread` component
- [ ] Display conversation header (name, participants for groups)
- [ ] Render messages with:
  - Blue bubbles for sent (from_me), gray for received
  - Rounded corners with tail effect
  - Timestamps grouped by day
  - Sender name for group chats
- [ ] Scroll to bottom on load and new messages
- [ ] Implement infinite scroll up for pagination (load older messages)

### 6.7 Message Input Component
- [ ] Create `MessageInput` component
- [ ] Text input with send button
- [ ] Send on Enter (Shift+Enter for newline)
- [ ] Disable while sending, show loading state
- [ ] Clear input on successful send

### 6.8 WebSocket Integration
- [ ] Connect to WebSocket on app load
- [ ] On `new_messages` event:
  - Update conversations list (move to top, update preview)
  - If conversation is selected, append new messages
- [ ] Handle reconnection gracefully

### 6.9 Styling (iMessage Feel)
- [ ] Set up CSS variables for colors:
  - `--bubble-sent: #007AFF`
  - `--bubble-received: #E9E9EB`
  - `--background: #FFFFFF` (light) / `#1C1C1E` (dark)
- [ ] Use system font (-apple-system, SF Pro)
- [ ] Match bubble border-radius to iMessage (~18px, smaller on tail side)
- [ ] Match conversation list row height and padding
- [ ] Support dark mode (follow system preference)

### 6.10 Cmd+K Command Palette (Basic)
- [ ] Create `CommandPalette` component (modal overlay)
- [ ] Trigger on Cmd+K keydown
- [ ] Search input with fuzzy matching
- [ ] Basic commands:
  - "Go to [contact name]" → navigate to conversation
  - "Search [query]" → open search results
- [ ] Keyboard navigation (arrow keys, Enter to select)

---

## Phase 7: Integration & Packaging

### 7.1 Build Pipeline
- [ ] Create build script that:
  1. Builds Rust crate: `cd core && maturin build --release`
  2. Bundles Python backend with PyInstaller:
     `pyinstaller --onefile --add-binary "core.so:." backend/app/main.py`
  3. Copies bundled backend to Electron resources
  4. Builds Electron app: `electron-builder --mac`
- [ ] Test the build script end-to-end

### 7.2 First Run Experience
- [ ] On first launch, check if prm.db exists
- [ ] If not, show onboarding:
  - Request Full Disk Access (instructions)
  - Run contacts hydration (show progress)
  - Run initial message sync (show progress)
- [ ] Store "onboarding complete" flag

### 7.3 End-to-End Testing
- [ ] Launch packaged app
- [ ] Verify conversation list loads
- [ ] Verify selecting a conversation loads messages
- [ ] Verify sending a message works
- [ ] Verify receiving a new message shows in real-time
- [ ] Verify Cmd+K opens and navigation works

---

## Phase 8: Polish & Stability (Post-MVP)

### 8.1 Performance
- [ ] Profile conversation list rendering with 500+ conversations
- [ ] Profile message thread with 1000+ messages
- [ ] Add virtualization if needed (react-window or similar)

### 8.2 Error Handling
- [ ] Handle chat.db locked errors gracefully
- [ ] Handle network errors in sender
- [ ] Show user-friendly error messages in UI

### 8.3 Logging
- [ ] Add structured logging to FastAPI
- [ ] Log sync events for debugging
- [ ] Log send attempts and results

---

## Milestone Checklist

### M1: Rust Core Working
- [ ] prm.db created and schema working
- [ ] chat.db reader working
- [ ] Identifier resolution working
- [ ] PyO3 bindings importable from Python

### M2: Backend API Working
- [ ] REST endpoints returning data
- [ ] WebSocket broadcasting updates
- [ ] Contacts hydrated and indexed

### M3: Read-Only UI Working
- [ ] Conversation list rendering
- [ ] Message thread rendering
- [ ] Real-time updates flowing through

### M4: Send Working
- [ ] Message sending via AppleScript
- [ ] Confirmation polling
- [ ] UI updates after send

### M5: Packaged App
- [ ] Single .app bundle working
- [ ] First-run onboarding working
- [ ] App feels like iMessage

---

## File Quick Reference

| Component | Location | Purpose |
|-----------|----------|---------|
| Rust core | `core/src/` | Database ops, sync, PyO3 |
| App database | `~/.prm/prm.db` | Contacts, conversations, metadata |
| FastAPI | `backend/app/` | REST + WebSocket API |
| Electron main | `frontend/src/main/` | Window, backend lifecycle |
| Electron UI | `frontend/src/renderer/` | React/Svelte components |
| Build scripts | `scripts/` | Build automation |

---

## Commands Quick Reference

```bash
# Development
cd core && maturin develop --uv     # Build Rust, install with uv
cd backend && uv run uvicorn app.main:app --reload  # Run FastAPI
cd frontend && npm run dev          # Run Electron in dev mode

# Testing
uv run python -c "import core; print('OK')"  # Verify Rust module
curl http://localhost:8000/api/conversations  # Test REST
websocat ws://localhost:8000/ws         # Test WebSocket

# Production Build
./scripts/build.sh                      # Full build pipeline

# UV Basics
uv venv                                 # Create virtual environment
uv add <package>                        # Add dependency
uv add --editable <path>                # Add local package in editable mode
uv run <command>                        # Run command in uv environment
uv tool install <package>               # Install global tool (like maturin)
```


