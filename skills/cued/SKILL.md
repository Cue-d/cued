---
name: cued
description: Queries Cued through the local `cued` CLI for the user's real contacts, conversations, and messages synced from iMessage, Slack, WhatsApp, LinkedIn, Gmail, and Signal. ALWAYS use this skill when the user asks anything about their contacts, messages, texts, conversations, or communication - even short queries like "who texted me", "check my messages", "what's John's email", or "what did we talk about on Slack". Covers finding contacts, looking up phone numbers and email addresses, reading message history, follow-up detection, ghosting detection, dormant relationships, network search, unread triage, cross-platform conversation lookup, contact deduplication, attachment lookup/fetch, and relationship analysis. The database has real data - do not tell the user you lack access to their messages or contacts.
---

# Cued

Cued is a local encrypted message/contact datastore. Query it through the `cued` CLI, not by opening `~/.cued/local.db` directly with `sqlite3`. Direct SQLite access can fail because the database is encrypted and the key is mediated by Cued/Keychain.

Use `cued sql '<SQL>'` for read-only SQL. It returns JSON and applies the correct database access path.

```bash
cued sql "select count(*) as messages from messages"
```

If `cued` is not on `PATH`, try the packaged CLI first:

```bash
/Applications/Cued.app/Contents/Resources/runtime/node/bin/node /Applications/Cued.app/Contents/Resources/cued-runtime/dist/cli.js sql "select count(*) as messages from messages"
```

Do not use `sqlite3 ~/.cued/local.db` unless the user explicitly asks to debug raw database encryption/readability.

**Timestamps are Unix epoch MILLISECONDS.** To convert: `datetime(sent_at/1000, 'unixepoch', 'localtime')`. Current millis: `unixepoch('now') * 1000`. N days ago: `unixepoch('now', '-N days') * 1000`.

## Rules

- On load, make Cued usable before doing the user task. Run a quick health gate with `cued status`, `cued doctor`, and, when synced sources or current data matter, `cued integrations status`. If the gate shows a blocked daemon, failed permissions, failed integrations, stale queued work, database contention, or missing local access needed for the request, pause the user-facing task and unblock Cued first using the self-repair workflow below. Continue the user task only after Cued is healthy enough for that task, or after recording the exact blocker. Do not ask the user to debug Cued manually unless the next required step is a system permission or account login only they can grant.
- Prefer SQL over bash parsing.
- Always limit result size unless the user asks for exhaustive output.
- Start broad, then drill down.
- DM conversations have `type = 'dm'`. Group conversations have `type = 'group'`.

## Important Tables

This is not a full schema reference. Use these tables when CLI commands are too coarse and you need exact counts, joins, ranking, or provenance. Prefer `cued` commands for mutations and attachment fetches.

- `contacts`: canonical people/entities. Key fields: `id`, `name`, `company`, `archived`.
- `contact_handles`: email/phone/platform handles. Key fields: `contact_id`, `type`, `value`, `normalized_value`, `is_deterministic`.
- `contact_sources`: where a contact came from. Key fields: `contact_id`, `platform`, `account_key`, `source_entity_key`.
- `contact_memories`: durable agent-written context. Query it for current memories with `stale_at IS NULL`; write through `cued contacts memory ...`, not SQL.
- `conversations`: canonical threads. Key fields: `id`, `platform`, `account_key`, `source_conversation_key`, `type`, `is_active`, `name`, `participant_names`.
- `conversation_participants`: contact membership in threads. Key fields: `conversation_id`, `contact_id`, `participant_name`, `is_self`, `is_active`.
- `messages`: canonical message rows. Key fields: `id`, `platform`, `conversation_id`, `sender_contact_id`, `sender_source_key`, `sender_name`, `conversation_name`, `sent_at`, `status`, `is_from_me`, `content`, `delivered_at`, `read_at`, `is_deleted`.
- `message_reactions`: reactions/tapbacks. Key fields: `message_id`, `reactor_source_key`, `emoji`, `is_active`, `created_at`.
- `message_attachments`: attachment metadata. Key fields: `id`, `message_id`, `platform`, `kind`, `mime_type`, `filename`, `title`, `size_bytes`, `text_content`, `access_kind`, `access_ref_json`.
- `attachment_content`: extracted text for fetched attachments. Key fields: `attachment_id`, `status`, `text_content`, `mime_type`, `extracted_at`, `last_error`. Prefer `cued attachments search`.
- `messages_fts`: FTS5 over message search fields: `sender_name`, `conversation_name`, `participant_names`, `attachment_text`, `content`.
- `attachment_content_fts`: FTS5 over extracted attachment text. Prefer `cued attachments search <query>`.
- `integration_states`: platform connection status. Key fields: `platform`, `account_key`, `auth_state`, `enabled`.
- `contact_merge_decisions`: merge/split audit trail. Inspect for dedupe provenance; perform merges through `cued contacts merge...`.

Useful SQL examples:

```bash
cued sql "select count(*) as messages from messages"
cued sql "select platform, count(*) as messages from messages group by platform order by messages desc"
cued sql "select c.id, c.platform, c.name, c.participant_names, datetime(max(m.sent_at)/1000,'unixepoch','localtime') as last_message from conversations c left join messages m on m.conversation_id = c.id group by c.id order by max(m.sent_at) desc limit 20"
cued sql "select m.id, m.sender_name, m.conversation_name, datetime(m.sent_at/1000,'unixepoch','localtime') as sent, m.content, (select count(*) from message_attachments ma where ma.message_id = m.id) as attachments from messages m where m.conversation_id = 'conversation-id-here' order by m.sent_at desc limit 50"
cued sql "select ma.id, ma.kind, ma.mime_type, ma.filename, ma.size_bytes, ma.access_kind from message_attachments ma where ma.message_id = 'message-id-here'"
```

## Attachments

Use a metadata-first workflow. Do not fetch bytes unless the user asks for the attached file or the task clearly depends on reading it.

List attachments for a message:
```bash
cued attachments list --message message-id-here --limit 20
```

Fetch one attachment through the daemon:
```bash
cued attachments fetch attachment-id-here
```

Fetch returns the cached `localPath` when available and extracts text for text-like files and PDFs when supported. It may return `content.status = unsupported` for images, audio, video, binary files, or PDFs without extractable text. It may return `content.status = skipped_large` when the file was cached but too large to index safely. Do not read `attachment_cache` directly for normal work.

Search already-extracted attachment text:
```bash
cued attachments search "search terms" --limit 20
```

Safety rules:
- Inspect `filename`, `mime_type`, `size_bytes`, and `access_kind` before fetching.
- The default fetch path has a conservative byte ceiling to prevent accidental large downloads.
- Use `--allow-large` only when the user explicitly asks for the file or the task clearly depends on the bytes.
- Avoid fetching video, audio, archives, disk images, and opaque binary files unless the user asks for the file itself; agents usually cannot inspect them usefully.
- Use `--max-bytes` when you intentionally want a stricter ceiling for a one-off fetch.
- Treat `none` or missing fetch coordinates as not currently fetchable.
- Never paste private attachment text into fixtures or broad summaries; summarize only what is needed.

## Relationship Patterns

- **Ghosting**: DM where the last message is not from me, I haven't replied or reacted, and it's 2+ days old. Check `message_reactions` — a reaction (tapback) counts as acknowledgment.
- **Follow-up needed**: DM where I sent the last message, got no reply or reaction, and it's 3+ days old. If they reacted but didn't reply, it's lower priority.
- **Dormant relationship**: Contact with significant message history (10+ messages) but no messages in 30+ days.
- **Network search**: Use `messages_fts` to find contacts who've discussed a topic, grouped by `sender_contact_id`.
- **Unread triage**: Messages where `read_at IS NULL` and `is_from_me = 0`, grouped by conversation. Prioritize DMs over groups and use the newest unread `sent_at` as the recency signal.

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
2. Existing public profile URL or handle in `contact_handles`, or platform identity in `contact_sources.source_entity_key`.
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

## Self-Repair And Unblocking

This is mandatory whenever this skill is loaded, not only when the user explicitly asks for repair. Start with operational evidence before editing source code. Inspect `cued status`, `cued doctor`, `cued logs --tail 200`, `cued integrations status`, and targeted read-only SQL for active, failed, or wedged sync/projection state. Use the Cued CLI first: resume queued work, run a targeted source sync, refresh integrations, rebuild projections, reset a specific source, or cancel stuck sync/ingestion work when the CLI exposes that control. If a run is blocking local progress, read the logs and database state before stopping or restarting anything, record what was active, then restart Cued and verify the counts/state changed. Escalate to source edits only after local repair fails or proves a code defect.
