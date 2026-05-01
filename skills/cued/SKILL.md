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

### contact_memories
Successful useful agent memories for a contact. These are durable agent context, not projected source data. Only current memories have `stale_at IS NULL`.
```
id TEXT PRIMARY KEY
contact_id TEXT
body TEXT
source_kind TEXT      -- local_messages, web_search, linkedin, manual, agent, etc.
evidence_json TEXT    -- message ids, URLs, handles, profile ids, query evidence
confidence INTEGER    -- optional 0-100
supersedes_memory_id TEXT
stale_at INTEGER
created_by TEXT
created_at INTEGER
updated_at INTEGER
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
primary_contact_id TEXT
secondary_contact_id TEXT
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
- **Merge duplicates**: `cued contacts merge <primary-id> <secondary-id> [--reason TEXT]` for one merge, or `cued contacts merge-batch merges.json --apply` for many exact-evidence merges with one rebuild. `merge-batch` dry-runs by default when `--apply` is omitted.
- **Merge audit trail**: Manual merges are recorded in `contact_merge_decisions`, so they survive rebuilds and replay.
- **Contact memories**: Use `contact_memories` for compact, evidence-backed agent memory. Write via `cued contacts memory ...`, not arbitrary SQL.

## Contact Memories

Use memories for facts that should improve future search, enrichment, or follow-up. Do not write memories for failed, ambiguous, or skipped enrichment attempts.

Add a memory:
```bash
cued contacts memory add contact-id-here "Works on applied AI; likely useful for Cued enrichment feedback." --source local_messages --confidence 90 --evidence '{"message_ids":["message-id-here"]}'
```

List current memories:
```bash
cued contacts memory list contact-id-here --limit 20
```

Replace stale or incorrect information:
```bash
cued contacts memory add contact-id-here "Now works at ExampleCo, based on LinkedIn profile and recent messages." --source linkedin --confidence 95 --evidence '{"urls":["https://www.linkedin.com/in/example"],"message_ids":["message-id-here"]}' --supersedes memory-id-here
```

Mark a memory stale without replacement:
```bash
cued contacts memory stale memory-id-here
```

Before writing a memory, verify at least one of:
- deterministic handle evidence: LinkedIn profile URL/id, email, phone, or platform id;
- strong DM history with the contact;
- local message evidence that directly supports the memory.

Do not write a memory from name-only web search. Skip memory writes for weak contacts, bots, OTP/verification senders, one-off spam, placeholders, LinkedIn-only imports with no local interaction, or duplicate-name clusters without exact normalized-handle overlap.

## Contact Enrichment

Enrichment is a local-first identity task, not a web search task. Prioritize contacts that are likely to matter and only write successful, identity-linked memories.

Queue candidates in this order:
- high-recency or high-volume human DMs with missing company/profile context;
- contacts with deterministic handles or profile URLs already in `contact_handles` / `contact_sources`;
- duplicate clusters where exact handles can enrich the canonical record;
- high-value contacts from recent meetings, calls, or messages that still lack public profile context.

Deprioritize or skip service senders, newsletters, stores, bots, OTP/verification senders, one-off contacts, family/private contacts unless explicitly requested, and contacts with only a name and no local relationship evidence.

Use this source order:
1. Local identity evidence: exact email, phone, LinkedIn URL/id, platform user id, profile URL, message history.
2. Existing public profile URL from `contact_sources.profile_url` or `contact_handles`.
3. Web search for the exact profile handle or exact full name plus known affiliation.
4. Cross-profile links from a verified source, such as a personal site linking GitHub/X/LinkedIn.

Identity proof tiers:
- **Write**: an exact local profile URL/handle matches the public page, or a verified public page links to another profile with the same handle/name/affiliation.
- **Review**: name and affiliation mostly match, but there are multiple plausible people or one key detail conflicts.
- **No write**: name-only search, weak affiliation match, conflicting profiles, private/unverifiable account, or no useful long-term fact.

Good enrichment memories are compact and claim-specific:
- public profile graph: personal site, LinkedIn, GitHub, X, portfolio;
- current company/role only when supported by a current profile or recent local message;
- durable interests or work areas only when supported by local messages or a profile bio;
- useful follow-up context, such as likely founder/investor/recruiting relevance.

Do not update canonical contact fields from web search unless identity is deterministic and the field is directly supported. Prefer `cued contacts memory add ... --source web --evidence ...` for researched context. If two verified sources disagree, either supersede a stale memory with evidence or write nothing and report the conflict.
