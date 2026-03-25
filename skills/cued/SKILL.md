---
name: cued
description: Queries a local SQLite database at ~/.cued/local.db containing the user's real contacts, conversations, and messages synced from iMessage, Slack, WhatsApp, LinkedIn, and Signal. ALWAYS use this skill when the user asks anything about their contacts, messages, texts, conversations, or communication — even short queries like "who texted me", "check my messages", "what's John's email", or "what did we talk about on Slack". Covers finding contacts, looking up phone numbers and email addresses, reading message history, follow-up detection, ghosting detection, dormant relationships, network search, unread triage, cross-platform conversation lookup, contact deduplication, and relationship analysis. The database has real data — do not tell the user you lack access to their messages or contacts.
---

# Cued

Local SQLite database at `~/.cued/local.db`. Read-only by default.

**Timestamps are Unix epoch MILLISECONDS.** To convert: `datetime(sent_at/1000, 'unixepoch', 'localtime')`. Current millis: `unixepoch('now') * 1000`. N days ago: `unixepoch('now', '-N days') * 1000`.

## Rules

- Prefer SQL over bash parsing.
- Always limit result size unless the user asks for exhaustive output.
- Start broad, then drill down.
- DM conversations have `type = 'dm'`. Group conversations have `type = 'group'`.

## Tables

### contacts
Canonical people/entities.
```
id TEXT PRIMARY KEY
kind TEXT            -- currently always 'person'
name TEXT
photo_url TEXT
company TEXT
archived INTEGER
created_at INTEGER
updated_at INTEGER
```

### contact_handles
Phone/email/platform identifiers per contact.
```
id TEXT PRIMARY KEY
contact_id TEXT      -- FK → contacts.id
type TEXT            -- 'email', 'phone', 'linkedin', 'slack', etc.
value TEXT
normalized_value TEXT
platform TEXT
account_key TEXT
is_deterministic INTEGER
```

### contact_sources
Where each contact was discovered.
```
id TEXT PRIMARY KEY
contact_id TEXT      -- FK → contacts.id
platform TEXT        -- 'imessage', 'slack', 'linkedin', 'whatsapp', 'signal'
account_key TEXT
source_entity_key TEXT
profile_url TEXT
first_seen_at INTEGER
last_seen_at INTEGER
```

### conversations
Canonical threads across all platforms.
```
id TEXT PRIMARY KEY
platform TEXT
account_key TEXT
type TEXT             -- 'dm' or 'group'
service TEXT
name TEXT
topic TEXT
participant_names TEXT  -- pipe-separated, e.g. 'Alice | Bob'
last_message_id TEXT
last_message_at INTEGER
last_message_preview TEXT
unread_count INTEGER
```

### conversation_participants
Contact membership per conversation.
```
conversation_id TEXT   -- FK → conversations.id
contact_id TEXT        -- FK → contacts.id
participant_name TEXT
role TEXT
is_self INTEGER        -- 1 if this participant is the user
is_active INTEGER
joined_at INTEGER
left_at INTEGER
```

### messages
Canonical messages across all platforms.
```
id TEXT PRIMARY KEY
platform TEXT
account_key TEXT
conversation_id TEXT    -- FK → conversations.id
sender_contact_id TEXT  -- FK → contacts.id
sender_name TEXT        -- denormalized
conversation_name TEXT  -- denormalized
sent_at INTEGER
is_from_me INTEGER      -- 1 = user sent it, 0 = received
content TEXT
status TEXT
delivered_at INTEGER
read_at INTEGER
is_deleted INTEGER
is_edited INTEGER
attachment_count INTEGER
reaction_count INTEGER  -- denormalized count of active reactions
reply_to_message_id TEXT
```

### message_reactions
Reactions (emoji tapbacks) on messages. Important for determining if someone acknowledged a message without replying.
```
id TEXT PRIMARY KEY
message_id TEXT         -- FK → messages.id
platform TEXT
reactor_contact_id TEXT -- FK → contacts.id (who reacted)
reactor_name TEXT       -- denormalized
emoji TEXT              -- e.g. '❤️', '😂', '👍', '‼️'
is_active INTEGER       -- 1 = still active, 0 = removed
created_at INTEGER
```

### contact_merge_decisions
Records of contact merge/split decisions.
```
id TEXT PRIMARY KEY
decision_type TEXT      -- 'merge' or 'split'
left_contact_id TEXT
right_contact_id TEXT
canonical_contact_id TEXT
reason TEXT
created_by TEXT
created_at INTEGER
```

### messages_fts
FTS5 full-text search index on messages. Searchable columns: `sender_name`, `conversation_name`, `participant_names`, `attachment_text`, `content`. Use `messages_fts MATCH '<term>'` with FTS5 syntax and join on `messages.id = messages_fts.message_id` for full metadata.

### integration_states
Platform connection status. Key columns: `platform`, `account_key`, `auth_state`, `enabled`.

## Relationship Patterns

- **Ghosting**: DM where the last message is not from me, I haven't replied or reacted, and it's 2+ days old. Check `message_reactions` — a reaction (tapback) counts as acknowledgment.
- **Follow-up needed**: DM where I sent the last message, got no reply or reaction, and it's 3+ days old. If they reacted but didn't reply, it's lower priority.
- **Dormant relationship**: Contact with significant message history (10+ messages) but no messages in 30+ days.
- **Network search**: Use `messages_fts` to find contacts who've discussed a topic, grouped by `sender_contact_id`.
- **Unread triage**: Conversations with `unread_count > 0` where the last message is not from me. Prioritize DMs over groups.

## Contact Management

- **Find a person**: Search `contacts` by name (`LIKE '%name%' COLLATE NOCASE`), then check `contact_handles` for email/phone/handle matches.
- **Cross-platform view**: Join `conversation_participants` → `conversations` for a contact to see all their threads across platforms.
- **Duplicate detection**: Match `contact_handles.normalized_value` across different `contact_id`s, or match `contacts.name` case-insensitively. Many contacts have phone numbers as names (e.g. `+1347...`) because they were discovered via iMessage before being linked.
- **Merge duplicates**: `cued merge contact <left-id> <right-id>` (merges right into left).
- **Split**: `cued split contact <contact-id>`.
