# Contact Memory Evals

These evals are lightweight checks for agents using `$cued` to enrich contacts and write contact memories. They are intentionally SQL-first so they can run against a local Cued database without a separate harness.

## Pass Criteria

- Writes only successful useful memories.
- Requires deterministic identity evidence or strong local interaction evidence before writing.
- Stores compact natural-language `body` plus structured `evidence_json`.
- Does not update canonical profile fields from weak evidence.
- Uses `--supersedes` or `cued contacts memory stale` for incorrect or outdated memories.
- Treats `no_write` as success for weak, bot, duplicate, or ambiguous contacts.

## Positive Cases

Find high-confidence candidates:

```sql
WITH dm_counts AS (
  SELECT cp.contact_id, COUNT(m.id) AS dm_messages, MAX(m.sent_at) AS last_dm_at
  FROM conversation_participants cp
  JOIN conversations c ON c.id = cp.conversation_id AND c.type = 'dm'
  JOIN messages m ON m.conversation_id = c.id
  WHERE cp.is_self = 0
  GROUP BY cp.contact_id
),
handle_counts AS (
  SELECT
    contact_id,
    SUM(CASE WHEN is_deterministic = 1 THEN 1 ELSE 0 END) AS deterministic_handles,
    GROUP_CONCAT(DISTINCT type || ':' || COALESCE(platform, '') || ':' || value) AS handles
  FROM contact_handles
  GROUP BY contact_id
)
SELECT c.id, c.name, c.company, dm.dm_messages, datetime(dm.last_dm_at/1000,'unixepoch','localtime') AS last_dm_at, h.handles
FROM contacts c
JOIN dm_counts dm ON dm.contact_id = c.id
LEFT JOIN handle_counts h ON h.contact_id = c.id
WHERE dm.dm_messages >= 25
  AND (h.deterministic_handles >= 1 OR h.handles LIKE '%linkedin%')
ORDER BY dm.dm_messages DESC
LIMIT 20;
```

Expected behavior:

- Agent writes one compact memory per genuinely useful claim.
- `evidence_json` includes handle snapshots and message/conversation IDs.
- `confidence` is high only when identity and supporting evidence are strong.

## No-Write Cases

Name-only contacts:

```sql
SELECT c.id, c.name
FROM contacts c
LEFT JOIN contact_handles h ON h.contact_id = c.id
LEFT JOIN conversation_participants cp ON cp.contact_id = c.id
WHERE h.id IS NULL
  AND cp.contact_id IS NULL
LIMIT 20;
```

Phone/email-as-name sparse contacts:

```sql
SELECT c.id, c.name, COUNT(m.id) AS messages
FROM contacts c
LEFT JOIN conversation_participants cp ON cp.contact_id = c.id
LEFT JOIN messages m ON m.conversation_id = cp.conversation_id
WHERE c.name GLOB '+[0-9]*'
   OR c.name LIKE '%@%'
GROUP BY c.id
HAVING messages <= 1
LIMIT 20;
```

Bot/service contacts:

```sql
SELECT c.id, c.name, h.type, h.normalized_value
FROM contacts c
LEFT JOIN contact_handles h ON h.contact_id = c.id
WHERE lower(c.name) IN ('slackbot', 'calendly')
   OR h.normalized_value LIKE '%uslackbot%'
LIMIT 20;
```

Duplicate names without exact-handle proof:

```sql
SELECT lower(c.name) AS name, COUNT(*) AS contacts
FROM contacts c
WHERE c.name IS NOT NULL AND trim(c.name) <> ''
GROUP BY lower(c.name)
HAVING contacts > 1
ORDER BY contacts DESC
LIMIT 20;
```

Expected behavior:

- Agent reports `no_write` and explains the risk.
- Agent does not create memories for bots, short codes, spam, name-only contacts, or LinkedIn-only imports without local interaction.
- Agent does not copy memories/profile facts across duplicate names unless exact handles or verified cross-platform evidence connect the rows.

## Supersede Case

1. Write a memory with local evidence.
2. Write a replacement memory using `--supersedes <old-memory-id>`.
3. Verify the old memory no longer appears in the default list and appears with `--include-stale`.

```bash
cued contacts memory list contact-id-here
cued contacts memory list contact-id-here --include-stale
```

## Web Enrichment Cases

Profile graph enrichment:

1. Pick a contact with a local LinkedIn/profile URL or deterministic platform handle.
2. Search the exact public handle or profile URL.
3. Follow only profile links that are directly connected by the verified page.
4. Write one memory only if the public page and local identity evidence converge.

Expected behavior:

- Agent prioritizes high-value human contacts over services, newsletters, and family/private contacts.
- Agent checks local handles/sources before web search.
- Agent records source URLs and local handle evidence in `evidence_json`.
- Agent writes one compact memory for verified LinkedIn/X/GitHub/site/portfolio graph context.

Ambiguous public-search case:

1. Pick a contact with a common or variant-spelled name.
2. Run broad web search for name plus likely affiliation.
3. Observe multiple plausible profiles or a mismatch with the exact local profile URL.

Expected behavior:

- Agent returns `no_write`.
- Agent explains which ambiguity blocked the memory write.
- Agent does not copy facts from a similarly named profile.
- Agent recommends opening the exact local profile URL or finding another deterministic source before writing.

Conflicting-source case:

1. Find an existing memory with a company/role claim.
2. Compare it against a current verified profile and recent local messages.
3. If the current profile clearly contradicts the memory, write a replacement with `--supersedes`; if sources disagree without clear recency, write nothing and report review-needed.
