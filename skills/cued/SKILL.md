---
name: cued
description: Use this skill when a task requires inspecting Cued's local SQLite database for contacts, conversations, messages, relationship analysis, or communication patterns. This includes finding who someone ghosted, who to follow up with, dormant relationships, network analysis, cross-platform message history, unread triage, and any question about who the user has been talking to, when, and on which platform. Prefer direct SQL via sqlite3 with JSON output against ~/.cued/local.db. Use this skill proactively whenever the user mentions contacts, messages, conversations, follow-ups, introductions, networking, ghosting, or communication history — even if they don't explicitly say "cued."
---

# Cued

The agent-facing interface is the SQLite database at `~/.cued/local.db`.

Default command form:

```bash
sqlite3 -json ~/.cued/local.db "<query>"
```

**Timestamps are Unix epoch MILLISECONDS** (not seconds). To convert: `datetime(sent_at/1000, 'unixepoch', 'localtime')`.
To get "N days ago" in millis: `unixepoch('now', '-7 days') * 1000`.
To get current time in millis: `unixepoch('now') * 1000`.

## Rules

- Read-only by default.
- Prefer SQL over bash parsing.
- Always limit result size unless the user asks for exhaustive output.
- Start broad, then drill down.
- For person enrichment, use local evidence first and web search second.
- DM conversations have `type = 'dm'`. Group conversations have `type = 'group'`.

## Tables

### contacts
Canonical people/entities.
```
id TEXT PRIMARY KEY
kind TEXT            -- 'person', 'company', 'bot', 'group', 'other'
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
FTS5 full-text search index on messages. Searchable columns: `sender_name`, `conversation_name`, `participant_names`, `attachment_text`, `content`.

```sql
SELECT message_id, sender_name, conversation_name, content
FROM messages_fts
WHERE messages_fts MATCH 'fundraising'
ORDER BY rank
LIMIT 50;
```

To join FTS results back to messages for full metadata:
```sql
SELECT m.*, fts.rank
FROM messages_fts fts
JOIN messages m ON m.id = fts.message_id
WHERE messages_fts MATCH 'fundraising'
ORDER BY fts.rank
LIMIT 50;
```

## Query Patterns

### List recent contacts with last activity

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c.id, c.name, c.company,
  GROUP_CONCAT(DISTINCT ch.type || ':' || ch.value) AS handles,
  MAX(m.sent_at) AS last_message_at
FROM contacts c
LEFT JOIN contact_handles ch ON ch.contact_id = c.id
LEFT JOIN messages m ON m.sender_contact_id = c.id OR (
  m.conversation_id IN (
    SELECT cp.conversation_id FROM conversation_participants cp WHERE cp.contact_id = c.id
  ) AND m.is_from_me = 1
)
WHERE c.archived = 0
GROUP BY c.id
ORDER BY last_message_at DESC
LIMIT 20;
"
```

### Find a contact by name or company

```bash
sqlite3 -json ~/.cued/local.db "
SELECT c.id, c.name, c.company,
  GROUP_CONCAT(DISTINCT ch.type || ':' || ch.value) AS handles
FROM contacts c
LEFT JOIN contact_handles ch ON ch.contact_id = c.id
WHERE c.name LIKE '%alex%' COLLATE NOCASE
   OR c.company LIKE '%vercel%' COLLATE NOCASE
GROUP BY c.id
LIMIT 20;
"
```

### Find a contact by handle (email, phone, username)

```bash
sqlite3 -json ~/.cued/local.db "
SELECT c.id, c.name, ch.type, ch.value, ch.platform
FROM contact_handles ch
JOIN contacts c ON c.id = ch.contact_id
WHERE ch.normalized_value = 'someone@example.com' COLLATE NOCASE
LIMIT 20;
"
```

### List recent conversations

```bash
sqlite3 -json ~/.cued/local.db "
SELECT id, platform, name, participant_names,
  last_message_preview, last_message_at,
  datetime(last_message_at/1000, 'unixepoch', 'localtime') AS last_message_time
FROM conversations
WHERE last_message_at IS NOT NULL
ORDER BY last_message_at DESC
LIMIT 25;
"
```

### Inspect recent messages in a conversation

```bash
sqlite3 -json ~/.cued/local.db "
SELECT sender_name, content, sent_at,
  datetime(sent_at/1000, 'unixepoch', 'localtime') AS sent_time,
  is_from_me, status
FROM messages
WHERE conversation_id = '<conversation-id>'
ORDER BY sent_at DESC
LIMIT 100;
"
```

### Search messages by topic (FTS)

```bash
sqlite3 -json ~/.cued/local.db "
SELECT m.sender_name, m.conversation_name, m.content,
  datetime(m.sent_at/1000, 'unixepoch', 'localtime') AS sent_time,
  m.platform
FROM messages_fts fts
JOIN messages m ON m.id = fts.message_id
WHERE messages_fts MATCH 'fundraising'
ORDER BY m.sent_at DESC
LIMIT 50;
"
```

### Find all conversations with a contact (cross-platform)

```bash
sqlite3 -json ~/.cued/local.db "
SELECT conv.id, conv.platform, conv.name, conv.type,
  conv.participant_names,
  datetime(conv.last_message_at/1000, 'unixepoch', 'localtime') AS last_message_time
FROM conversation_participants cp
JOIN conversations conv ON conv.id = cp.conversation_id
WHERE cp.contact_id = '<contact-id>'
  AND cp.is_active = 1
ORDER BY conv.last_message_at DESC;
"
```

### Check integration and sync state

```bash
sqlite3 -json ~/.cued/local.db "
SELECT platform, account_key, auth_state AS status, enabled
FROM integration_states
ORDER BY platform;
"
```

## Relationship Intelligence Workflows

### Ghosting detection — "Who did I ghost?"

Find DM conversations where the other person sent the last message and I haven't replied OR reacted.
A reaction (tapback/emoji) counts as acknowledgment — if I reacted to their message, it's not ghosting.

```bash
sqlite3 -json ~/.cued/local.db "
WITH last_msgs AS (
  SELECT
    m.conversation_id,
    m.id AS message_id,
    m.sender_name,
    m.content,
    m.sent_at,
    m.is_from_me,
    m.reaction_count,
    ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC) AS rn
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.type = 'dm'
    AND m.is_deleted = 0
),
my_reactions AS (
  SELECT DISTINCT mr.message_id
  FROM message_reactions mr
  JOIN last_msgs lm ON lm.message_id = mr.message_id AND lm.rn = 1
  WHERE mr.reactor_contact_id IN (
    SELECT cp.contact_id FROM conversation_participants cp WHERE cp.is_self = 1
  )
  AND mr.is_active = 1
)
SELECT
  lm.sender_name,
  lm.content AS last_message,
  datetime(lm.sent_at/1000, 'unixepoch', 'localtime') AS sent_time,
  CAST((unixepoch('now') * 1000 - lm.sent_at) / 86400000.0 AS INTEGER) AS days_ago,
  c.platform,
  lm.reaction_count
FROM last_msgs lm
JOIN conversations c ON c.id = lm.conversation_id
LEFT JOIN my_reactions mr ON mr.message_id = lm.message_id
WHERE lm.rn = 1
  AND lm.is_from_me = 0
  AND lm.sent_at > unixepoch('now', '-30 days') * 1000
  AND lm.sent_at < unixepoch('now', '-2 days') * 1000
  AND mr.message_id IS NULL  -- Exclude messages I already reacted to
ORDER BY lm.sent_at DESC
LIMIT 25;
"
```

Adjust the time window: `-30 days` for lookback, `-2 days` for minimum ghosting threshold.
To include messages I reacted to (but still haven't texted back), remove the `my_reactions` CTE and the `AND mr.message_id IS NULL` filter.

### Follow-up detection — "Who should I follow up with?"

Find DM conversations where I sent the last message and got no reply or reaction.
If they reacted (e.g. liked/hearted my message), they acknowledged it — lower priority for follow-up.

```bash
sqlite3 -json ~/.cued/local.db "
WITH last_msgs AS (
  SELECT
    m.conversation_id,
    m.id AS message_id,
    m.content,
    m.sent_at,
    m.is_from_me,
    m.reaction_count,
    ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC) AS rn
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.type = 'dm'
    AND m.is_deleted = 0
),
their_reactions AS (
  SELECT DISTINCT mr.message_id
  FROM message_reactions mr
  WHERE mr.reactor_contact_id NOT IN (
    SELECT cp.contact_id FROM conversation_participants cp WHERE cp.is_self = 1
  )
  AND mr.is_active = 1
)
SELECT
  c.participant_names,
  lm.content AS my_last_message,
  datetime(lm.sent_at/1000, 'unixepoch', 'localtime') AS sent_time,
  CAST((unixepoch('now') * 1000 - lm.sent_at) / 86400000.0 AS INTEGER) AS days_ago,
  c.platform,
  CASE WHEN tr.message_id IS NOT NULL THEN 'yes' ELSE 'no' END AS they_reacted
FROM last_msgs lm
JOIN conversations c ON c.id = lm.conversation_id
LEFT JOIN their_reactions tr ON tr.message_id = lm.message_id
WHERE lm.rn = 1
  AND lm.is_from_me = 1
  AND lm.sent_at > unixepoch('now', '-30 days') * 1000
  AND lm.sent_at < unixepoch('now', '-3 days') * 1000
ORDER BY
  CASE WHEN tr.message_id IS NULL THEN 0 ELSE 1 END,  -- No reaction = higher priority
  lm.sent_at DESC
LIMIT 25;
"
```

Results with `they_reacted = 'yes'` are lower priority — they saw the message but chose not to text back.

### Dormant relationships — "Who haven't I talked to in a while?"

Find contacts with significant past conversation history but no recent messages.

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c.name,
  c.company,
  COUNT(m.id) AS total_messages,
  MAX(m.sent_at) AS last_message_epoch,
  datetime(MAX(m.sent_at)/1000, 'unixepoch', 'localtime') AS last_message_time,
  CAST((unixepoch('now') * 1000 - MAX(m.sent_at)) / 86400000.0 AS INTEGER) AS days_since_last,
  GROUP_CONCAT(DISTINCT conv.platform) AS platforms
FROM contacts c
JOIN conversation_participants cp ON cp.contact_id = c.id AND cp.is_self = 0
JOIN conversations conv ON conv.id = cp.conversation_id AND conv.type = 'dm'
JOIN messages m ON m.conversation_id = conv.id AND m.is_deleted = 0
WHERE c.archived = 0
GROUP BY c.id
HAVING total_messages >= 10
  AND days_since_last > 30
ORDER BY total_messages DESC
LIMIT 25;
"
```

### Network search — "Who might help with X?"

Use FTS to find contacts who've discussed a topic, then return contact info.

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c.name,
  c.company,
  COUNT(DISTINCT m.id) AS mention_count,
  GROUP_CONCAT(DISTINCT conv.platform) AS platforms,
  datetime(MAX(m.sent_at)/1000, 'unixepoch', 'localtime') AS last_mention
FROM messages_fts fts
JOIN messages m ON m.id = fts.message_id
JOIN conversations conv ON conv.id = m.conversation_id
LEFT JOIN contacts c ON c.id = m.sender_contact_id
WHERE messages_fts MATCH '<topic>'
  AND m.is_from_me = 0
  AND c.name IS NOT NULL
GROUP BY c.id
ORDER BY mention_count DESC
LIMIT 20;
"
```

Replace `<topic>` with the search term. Use FTS5 syntax: `'fundraising OR investing'`, `'NEAR(series funding)'`.

### Unread triage — "What are my most important unread messages?"

Only show conversations where the last message was NOT sent by me (if I sent the last message, it's not really "unread" in a meaningful way).

```bash
sqlite3 -json ~/.cued/local.db "
WITH last_msg_info AS (
  SELECT
    m.conversation_id,
    m.is_from_me,
    m.sender_name,
    ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC) AS rn
  FROM messages m
  WHERE m.is_deleted = 0
)
SELECT
  conv.name AS conversation_name,
  conv.participant_names,
  conv.platform,
  conv.unread_count,
  conv.last_message_preview,
  datetime(conv.last_message_at/1000, 'unixepoch', 'localtime') AS last_message_time,
  conv.type,
  lmi.sender_name AS last_sender
FROM conversations conv
JOIN last_msg_info lmi ON lmi.conversation_id = conv.id AND lmi.rn = 1
WHERE conv.unread_count > 0
  AND lmi.is_from_me = 0  -- Last message was NOT from me
ORDER BY conv.last_message_at DESC
LIMIT 25;
"
```

For importance ranking, cross-reference with message frequency and prioritize DMs over groups:

```bash
sqlite3 -json ~/.cued/local.db "
WITH last_msg_info AS (
  SELECT
    m.conversation_id,
    m.is_from_me,
    ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC) AS rn
  FROM messages m
  WHERE m.is_deleted = 0
)
SELECT
  conv.participant_names,
  conv.platform,
  conv.type,
  conv.unread_count,
  conv.last_message_preview,
  COUNT(m.id) AS total_messages_30d
FROM conversations conv
JOIN last_msg_info lmi ON lmi.conversation_id = conv.id AND lmi.rn = 1
JOIN messages m ON m.conversation_id = conv.id
  AND m.sent_at > unixepoch('now', '-30 days') * 1000
WHERE conv.unread_count > 0
  AND lmi.is_from_me = 0
GROUP BY conv.id
ORDER BY
  CASE conv.type WHEN 'dm' THEN 0 ELSE 1 END,  -- DMs first
  total_messages_30d DESC,
  conv.last_message_at DESC
LIMIT 25;
"
```

### Intro matching — "Who should I introduce to each other?"

Find pairs of contacts who discuss similar topics but don't share conversations.

Step 1: Identify contacts with topic overlap via FTS.
Step 2: Verify they don't share any group conversations.
Step 3: Present pairs with shared topic context.

```bash
sqlite3 -json ~/.cued/local.db "
WITH topic_contacts AS (
  SELECT DISTINCT m.sender_contact_id AS contact_id, c.name, c.company
  FROM messages_fts fts
  JOIN messages m ON m.id = fts.message_id
  JOIN contacts c ON c.id = m.sender_contact_id
  WHERE messages_fts MATCH '<topic>'
    AND m.is_from_me = 0
    AND c.name IS NOT NULL
)
SELECT
  tc1.name AS contact_a,
  tc1.company AS company_a,
  tc2.name AS contact_b,
  tc2.company AS company_b
FROM topic_contacts tc1
JOIN topic_contacts tc2 ON tc1.contact_id < tc2.contact_id
WHERE NOT EXISTS (
  SELECT 1
  FROM conversation_participants cp1
  JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.contact_id = tc1.contact_id
    AND cp2.contact_id = tc2.contact_id
)
LIMIT 20;
"
```

## Contact Management Workflows

### Find a person

1. Search `contacts` by partial name using `LIKE '%name%' COLLATE NOCASE`.
2. If ambiguous, search `contact_handles` by email, phone, or platform handle.
3. Use `conversation_participants` to find their conversations.
4. Inspect recent messages before answering.

**Phone number resolution**: Many contacts have phone numbers as names (e.g. `+13475561329`) because they were discovered via iMessage before the contacts app linked them. To resolve:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c1.id AS phone_contact_id,
  c1.name AS phone_name,
  c2.id AS named_contact_id,
  c2.name AS real_name,
  ch2.platform AS named_platform
FROM contacts c1
JOIN contact_handles ch1 ON ch1.contact_id = c1.id AND ch1.type = 'phone'
JOIN contact_handles ch2 ON ch2.normalized_value = ch1.normalized_value AND ch2.contact_id != c1.id
JOIN contacts c2 ON c2.id = ch2.contact_id AND c2.name NOT LIKE '+%'
WHERE c1.name LIKE '+%'
LIMIT 25;
"
```

When a contact shows a phone number instead of a name, check if a named contact exists with the same phone number using the query above. If found, the two contacts can be merged.

### Find duplicate contacts across platforms

Contacts often exist as separate records on different platforms (e.g., someone on iMessage and Slack). Find duplicates by matching handles:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c1.id AS contact_a_id, c1.name AS contact_a_name,
  GROUP_CONCAT(DISTINCT cs1.platform) AS a_platforms,
  c2.id AS contact_b_id, c2.name AS contact_b_name,
  GROUP_CONCAT(DISTINCT cs2.platform) AS b_platforms,
  ch1.type AS match_type, ch1.normalized_value AS match_value
FROM contact_handles ch1
JOIN contact_handles ch2
  ON ch2.normalized_value = ch1.normalized_value
  AND ch2.type = ch1.type
  AND ch2.contact_id != ch1.contact_id
JOIN contacts c1 ON c1.id = ch1.contact_id AND c1.name IS NOT NULL AND c1.name NOT LIKE '+%'
JOIN contacts c2 ON c2.id = ch2.contact_id AND c2.name IS NOT NULL AND c2.name NOT LIKE '+%'
  AND c1.id < c2.id  -- avoid duplicate pairs
LEFT JOIN contact_sources cs1 ON cs1.contact_id = c1.id
LEFT JOIN contact_sources cs2 ON cs2.contact_id = c2.id
GROUP BY c1.id, c2.id
LIMIT 25;
"
```

Also find contacts with similar names across platforms:

```bash
sqlite3 -json ~/.cued/local.db "
SELECT
  c1.id AS contact_a_id, c1.name AS contact_a_name,
  GROUP_CONCAT(DISTINCT cs1.platform) AS a_platforms,
  c2.id AS contact_b_id, c2.name AS contact_b_name,
  GROUP_CONCAT(DISTINCT cs2.platform) AS b_platforms
FROM contacts c1
JOIN contacts c2
  ON lower(c1.name) = lower(c2.name)
  AND c1.id < c2.id
LEFT JOIN contact_sources cs1 ON cs1.contact_id = c1.id
LEFT JOIN contact_sources cs2 ON cs2.contact_id = c2.id
WHERE c1.name IS NOT NULL AND c1.name NOT LIKE '+%'
GROUP BY c1.id, c2.id
LIMIT 25;
"
```

### Merge contacts

Once you've identified duplicates, merge them using the CLI:

```bash
cued merge contact <left-contact-id> <right-contact-id>
```

This merges the right contact into the left, combining all handles, sources, conversations, and messages. The left contact becomes the canonical record.

To split a previously merged contact:
```bash
cued split contact <contact-id>
```

### Find recent messages on a topic

1. Use `messages_fts MATCH '<term>'` joined to `messages` for full metadata.
2. Narrow by contact or conversation only after the broad search returns candidates.

### Inspect the latest thread with a contact

1. Resolve the contact via name search.
2. Find conversations through `conversation_participants`.
3. Read `messages` ordered by `sent_at DESC`.

## Enrichment Guidelines

When asked to enrich or look up a person, follow this order:

### Step 1: Gather local evidence

1. Search `contacts` for name matches.
2. Pull all `contact_handles` — email, phone, LinkedIn URL, Slack handle, etc.
3. Check `contact_sources` for `profile_url` fields (especially LinkedIn URLs).
4. Read recent messages for contextual clues: company mentions, role, projects, location.
5. Check `company` field on the contact record.

### Step 2: Web search for public identity

Use the local evidence to construct targeted searches:

- If LinkedIn URL exists in `contact_sources.profile_url` or `contact_handles`, search for that directly.
- If email domain is known, search: `"firstname lastname" site:company-domain.com`
- If company is known: `"firstname lastname" "company name"`
- For general search: `"firstname lastname" linkedin OR twitter OR github`

### Step 3: Cross-reference and present

- Match the web results against local data to confirm identity (same company, same role, same location).
- Present findings in two clear sections: **From your messages** and **From the web**.
- Flag any uncertainty: "This LinkedIn profile likely matches based on [company/role], but I'm not 100% certain."
- Never present web-sourced information as if it came from the local database.

### Step 4: Suggest contact updates

If enrichment reveals information not in the local contact (e.g., company, email, LinkedIn URL), suggest what could be added. Note: the database is read-only from this skill, but the user can update contacts through the Cued app or merge duplicate records using `cued merge contact`.
