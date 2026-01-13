# Sync Directory

This directory will contain iMessage sync logic in Phase 2:

- `chat-db.ts` - SQLite reader for ~/Library/Messages/chat.db
- `contacts.ts` - AppleScript contact resolver
- `sync-manager.ts` - Incremental sync orchestration with ROWID cursor
- `api-client.ts` - HTTP client for Next.js /api/sync/imessage endpoint

Phase 2 will port logic from:
- `backend/db/chat_db.py`
- `backend/services/contacts/resolver.py`
- `backend/services/macos/contacts.py`
