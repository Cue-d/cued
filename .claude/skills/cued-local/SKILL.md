---
name: cued-local
description: Use this skill when a task requires inspecting Cued's local SQLite database for contacts, conversations, duplicate contacts, or message history. Prefer direct SQL via sqlite3 with JSON output. Use web search only after local evidence identifies a likely person and the task asks who they are.
---

# Cued Local

The agent-facing interface is the SQLite database at `~/.cued/local.db`.

For benchmark work, load [references/eval-harness.md](references/eval-harness.md) and [test-cases.json](test-cases.json).

Default command form:

```bash
sqlite3 -json ~/.cued/local.db "<query>"
```

## Rules

- Read-only by default.
- Prefer SQL over bash parsing.
- Prefer views before raw table joins.
- Always limit result size unless the user explicitly asks for exhaustive output.
- Start broad, then drill down.
- For person enrichment, use local evidence first, then web search.

## Tables

- `contacts`: canonical people/entities
- `contact_handles`: phone/email/platform identifiers
- `contact_sources`: where each contact came from
- `merge_suggestions`: ambiguous name-based duplicate suggestions
- `conversations`: canonical threads
- `conversation_participants`: contact membership per conversation
- `messages`: canonical messages across platforms
- `messages_fts`: FTS5 index for message search
- `sync_cursors`: per-platform local sync state
- `integrations`: connected local integrations

## Views

- `contact_directory`: contacts + handles + source platforms + last activity
- `conversation_directory`: conversations + participant names
- `message_timeline`: message rows joined with sender/conversation names
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

Find a contact by partial name:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, display_name, company, handles
FROM contact_directory
WHERE lower(display_name) LIKE lower('%alex%')
LIMIT 20;
"
```

Find a contact by company:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, display_name, company, handles
FROM contact_directory
WHERE lower(company) LIKE lower('%vercel%')
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

List recent conversations:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, platform, display_name, participant_names, last_message_text, last_message_at
FROM conversation_directory
ORDER BY last_message_at DESC
LIMIT 25;
"
```

Find conversations for one contact:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT DISTINCT
  conv.id,
  conv.platform,
  conv.display_name,
  conv.last_message_at,
  conv.last_message_text
FROM conversations conv
JOIN conversation_participants cp ON cp.conversation_id = conv.id
JOIN contacts c ON c.id = cp.contact_id
WHERE c.id = 'contact-id-here'
ORDER BY conv.last_message_at DESC
LIMIT 25;
"
```

Inspect recent messages in a conversation:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, content, sent_at, is_from_me, status
FROM message_timeline
WHERE conversation_id = 'conversation-id-here'
ORDER BY sent_at DESC
LIMIT 100;
"
```

Find messages about a topic:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, conversation_name, content, sent_at, platform
FROM message_search_results
WHERE message_search_results MATCH 'fundraising'
ORDER BY sent_at DESC
LIMIT 50;
"
```

Find messages about a topic for one contact:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT mt.sender_name, mt.conversation_name, mt.content, mt.sent_at, mt.platform
FROM message_search_results msr
JOIN message_timeline mt ON mt.id = msr.id
JOIN conversation_participants cp ON cp.conversation_id = mt.conversation_id
WHERE msr MATCH 'board meeting'
  AND cp.contact_id = 'contact-id-here'
ORDER BY mt.sent_at DESC
LIMIT 50;
"
```

Find all contacts tied to a company domain:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT DISTINCT c.id, c.display_name, c.company, h.value AS email
FROM contacts c
JOIN contact_handles h ON h.contact_id = c.id
WHERE h.handle_type = 'email'
  AND lower(h.value) LIKE '%@company.com'
ORDER BY c.display_name
LIMIT 100;
"
```

Check what integrations are active:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT platform, workspace_id, display_name, status, updated_at
FROM integrations
ORDER BY platform, workspace_id;
"
```

Check local sync cursors:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT platform, workspace_id, sync_mode, last_sync_at
FROM sync_cursors
ORDER BY platform, workspace_id;
"
```

Paginate older messages:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, content, sent_at
FROM message_timeline
WHERE conversation_id = 'conversation-id-here'
  AND sent_at < 1730000000000
ORDER BY sent_at DESC
LIMIT 100;
"
```

## Workflows

Find a person:
1. Search `contact_directory` by partial name.
2. If ambiguous, search `contact_handles` by company domain, email, phone, or platform handle.
3. Inspect their recent conversations before answering.

Find recent messages on a topic:
1. Use `message_search_results MATCH`.
2. Narrow by contact or conversation only after the broad search returns candidates.

Inspect the latest thread with a contact:
1. Find conversations via `conversation_participants`.
2. Open the newest `conversation_id`.
3. Read `message_timeline` ordered by `sent_at DESC`.

Check duplicates:
1. Read `merge_suggestions`.
2. Compare raw handles in `contact_handles`.
3. Treat suggestions as ambiguous until confirmed.

Enrich a person:
1. Identify the most likely contact from local handles, company, and recent messages.
2. Only then use web search for public identity/context.
3. State clearly which conclusions came from local data vs web results.
