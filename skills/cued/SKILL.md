---
name: cued
description: Use this skill when a task requires inspecting Cued's local SQLite database for contacts, conversations, duplicate contacts, integration state, or message history. Prefer direct SQL via sqlite3 with JSON output against ~/.cued/local.db. Use web search only after local evidence identifies a likely person and the task explicitly asks for public enrichment.
---

# Cued

The agent-facing interface is the SQLite database at `~/.cued/local.db`.

Default command form:

```bash
sqlite3 -json ~/.cued/local.db "<query>"
```

## Rules

- Read-only by default.
- Prefer SQL over bash parsing.
- Prefer views before raw table joins.
- Always limit result size unless the user asks for exhaustive output.
- Start broad, then drill down.
- For person enrichment, use local evidence first and web search second.

## Tables

- `contacts`: canonical people/entities
- `contact_handles`: phone/email/platform identifiers
- `contact_sources`: where each contact came from
- `merge_suggestions`: ambiguous duplicate suggestions
- `conversations`: canonical threads
- `conversation_participants`: contact membership per conversation
- `messages`: canonical messages across platforms
- `messages_fts`: FTS5 index for message search
- `sync_cursors`: per-platform local sync state
- `integrations`: connected local integrations

## Views

- `contact_directory`: contacts with handles, source platforms, and last activity
- `conversation_directory`: conversations with participant names
- `message_timeline`: messages joined with sender and conversation names
- `message_search_results`: `message_timeline` joined to the FTS table

## Query Patterns

List recent contacts:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, display_name, company, handles, last_message_at
FROM contact_directory
ORDER BY last_message_at DESC
LIMIT 20;
"
```

Find a contact by name or company:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, display_name, company, handles
FROM contact_directory
WHERE lower(display_name) LIKE lower('%alex%')
   OR lower(company) LIKE lower('%vercel%')
LIMIT 20;
"
```

Find a contact by handle:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT c.id, c.display_name, h.handle_type, h.value, h.platform
FROM contact_handles h
JOIN contacts c ON c.id = h.contact_id
WHERE lower(h.normalized_value) = lower('someone@example.com')
   OR lower(h.normalized_value) = lower('the_handle')
LIMIT 20;
"
```

List recent conversations:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, platform, display_name, participant_names, last_message_text, last_message_at
FROM conversation_directory
ORDER BY last_message_at DESC
LIMIT 25;
"
```

Inspect recent messages in one conversation:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, content, sent_at, is_from_me, status
FROM message_timeline
WHERE conversation_id = 'conversation-id-here'
ORDER BY sent_at DESC
LIMIT 100;
"
```

Search messages by topic:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, conversation_name, content, sent_at, platform
FROM message_search_results
WHERE message_search_results MATCH 'fundraising'
ORDER BY sent_at DESC
LIMIT 50;
"
```

Find duplicate-contact suggestions:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  ms.reason,
  ms.confidence,
  c1.display_name AS primary_name,
  c2.display_name AS secondary_name,
  ms.updated_at
FROM merge_suggestions ms
JOIN contacts c1 ON c1.id = ms.primary_contact_id
JOIN contacts c2 ON c2.id = ms.secondary_contact_id
WHERE ms.status = 'pending'
ORDER BY ms.confidence DESC, ms.updated_at DESC
LIMIT 50;
"
```

Check local integration and sync state:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT platform, workspace_id, display_name, status, updated_at
FROM integrations
ORDER BY platform, workspace_id;
"
```

```bash
sqlite3 -json ~/.cued/local.db "
SELECT platform, workspace_id, sync_mode, last_sync_at
FROM sync_cursors
ORDER BY platform, workspace_id;
"
```

## Workflows

Find a person:

1. Search `contact_directory` by partial name.
2. If ambiguous, search `contact_handles` by company domain, email, phone, or platform handle.
3. Inspect recent conversations before answering.

Find recent messages on a topic:

1. Use `message_search_results MATCH`.
2. Narrow by contact or conversation only after the broad search returns candidates.

Inspect the latest thread with a contact:

1. Resolve the contact.
2. Find conversations through `conversation_participants` or `conversation_directory`.
3. Read `message_timeline` ordered by `sent_at DESC`.

Check duplicates:

1. Read `merge_suggestions`.
2. Compare raw handles in `contact_handles`.
3. Treat suggestions as ambiguous until confirmed.

Enrich a person:

1. Identify the most likely contact from local handles, company, and recent messages.
2. Only then use web search for public identity or context.
3. State clearly which conclusions came from local data versus web results.
