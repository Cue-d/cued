# Self-driving CRM on Cued

A self-driving CRM should be an agent loop over durable local state, not a second application runtime. Cued owns identity, messages, memories, provenance, and search in SQLite; the agent owns the policy for what to inspect, research, remember, invalidate, and surface to the user.

Every loop follows the same contract:

1. Select a small candidate set with `cued sql`; use `cued contacts search` when the contact-FTS command is installed.
2. Resolve one canonical contact and load `cued contacts memory show <contact-id> --all`.
3. Gather only the evidence needed for this candidate.
4. Make one of four decisions: `no_change`, `add`, `supersede`, or `invalidate`.
5. Write through `cued contacts memory ...`; never mutate the encrypted database directly.
6. Return an audit record containing the contact id, evidence, decision, and command result.

The safe default is `no_change`. A run is successful when it finds nothing worth changing.

## Implementation 1: relationship radar

Use message history to find relationships that need attention, then use memories to explain why each person matters. This query finds DMs where the other person sent the latest message and the user has not replied or reacted:

```sql
WITH latest AS (
  SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC, m.id DESC) AS rn
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.type = 'dm' AND c.is_active = 1 AND m.is_deleted = 0
)
SELECT
  cp.contact_id,
  c.name,
  l.platform,
  l.content,
  l.sent_at
FROM latest l
JOIN conversation_participants cp
  ON cp.conversation_id = l.conversation_id AND cp.is_self = 0 AND cp.is_active = 1
JOIN contacts c ON c.id = cp.contact_id
WHERE l.rn = 1
  AND c.archived = 0
  AND l.is_from_me = 0
  AND l.sent_at < unixepoch('now', '-2 days') * 1000
  AND NOT EXISTS (
    SELECT 1
    FROM message_reactions r
    WHERE r.message_id = l.id AND r.is_active = 1 AND r.reactor_source_key IS NULL
  )
ORDER BY l.sent_at DESC
LIMIT 25;
```

For each result, load current memories and recent messages, then rank it. Do not write a memory saying somebody needs a reply; that is derived state and will go stale. Write only durable context discovered while preparing the recommendation.

## Implementation 2: pre-meeting brief

Resolve the person locally, load all current memories, then retrieve their recent cross-platform messages. Contact FTS is the preferred resolver when available; the base skill can resolve an exact or partial name with:

```sql
SELECT c.id, c.name, c.company, GROUP_CONCAT(h.type || ':' || h.value) AS handles
FROM contacts c
LEFT JOIN contact_handles h ON h.contact_id = c.id
WHERE c.name LIKE '%person name%' COLLATE NOCASE
GROUP BY c.id
LIMIT 20;
```

```sql
SELECT
  m.id AS message_id,
  m.conversation_id,
  m.platform,
  m.sent_at,
  m.is_from_me,
  m.sender_name,
  m.content
FROM conversation_participants cp
JOIN messages m ON m.conversation_id = cp.conversation_id
WHERE cp.contact_id = 'contact-id-here' AND m.is_deleted = 0
ORDER BY m.sent_at DESC
LIMIT 100;
```

The brief should contain the last interaction, open commitments, durable context from current memories, and the provenance for each claim. Reading a brief is not evidence that a memory changed, so the default action is no write.

## Implementation 3: enrichment and reconciliation

Start with contacts that have meaningful local interaction and incomplete fields. Process one person at a time; broad web search happens only after deterministic handles, profile URLs, and local message evidence have been collected.

Before any write, load the full memory history with `--all`. If new evidence corrects a current memory, write the replacement with `--supersedes`; if it disproves a memory without a replacement, invalidate it. Absence from a newer page is not contradictory evidence.

```bash
cued contacts memory add CONTACT_ID \
  "Now works at ExampleCo on developer tools." \
  --source web_profile \
  --confidence 95 \
  --evidence '{"urls":["https://example.com/team/person"]}' \
  --supersedes OLD_MEMORY_ID
```

## Implementation 4: X mutual and DM discovery

After Cued imports an X archive, relationship state is stored with the X contact source. This query finds mutuals from the most recently completed archive generation with a local DM relationship:

```sql
WITH current_x_generation AS (
  SELECT account_key, json_extract(coverage_json, '$.generation') AS generation
  FROM sync_proofs
  WHERE platform = 'x' AND proof_kind = 'messages' AND status = 'complete'
  ORDER BY last_observed_at DESC
  LIMIT 1
)
SELECT
  c.id,
  c.name,
  json_extract(cs.metadata_json, '$.followersCount') AS followers,
  COUNT(DISTINCT m.id) AS dm_messages,
  MAX(m.sent_at) AS last_dm_at
FROM contact_sources cs
JOIN current_x_generation xg
  ON xg.account_key = cs.account_key
  AND xg.generation = json_extract(cs.metadata_json, '$.archiveGeneration')
JOIN contacts c ON c.id = cs.contact_id
JOIN conversation_participants cp
  ON cp.contact_id = c.id AND cp.is_self = 0 AND cp.is_active = 1
JOIN conversations conv
  ON conv.id = cp.conversation_id
  AND conv.platform = 'x'
  AND conv.account_key = cs.account_key
  AND conv.type = 'dm'
  AND conv.is_active = 1
JOIN messages m ON m.conversation_id = conv.id AND m.is_deleted = 0
WHERE cs.platform = 'x'
  AND json_extract(cs.metadata_json, '$.mutual') = 1
GROUP BY c.id, c.name
ORDER BY dm_messages DESC, last_dm_at DESC
LIMIT 50;
```

Mutual status is source metadata, not a memory: a newer archive generation can refresh it deterministically. Agents may create a memory from the DM content or verified public context, but should not duplicate `mutual = true` into prose.

## What the agent owns

The agent decides which candidates deserve work, which sources are sufficient, and which memories conflict. Cued supplies deterministic identity resolution, exhaustive memory history, evidence-bearing writes, invalidation, FTS, and provider provenance. Keeping that boundary means different agents can implement different CRM policies over the same auditable person graph without each shipping another contact database, sync daemon, or dashboard.
