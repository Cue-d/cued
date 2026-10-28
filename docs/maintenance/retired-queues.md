# Retired job queue and outbound sending

Cued no longer exposes the unused generic job queue or the disabled outbound
message execution path. The daemon has no outbound drain loop, provider send
API, or send-echo tracker to re-enable.

The `jobs` and `outbound_messages` tables, indexes, schema declarations, enum
values, and historical migrations remain for database compatibility. Existing
rows are preserved as inert records, including pending drafts and running jobs.
New databases receive the same schema. Do not remove these tables or rewrite
historical migrations as part of application dead-code cleanup.

Active sync runs, message indexing, and ingestion of messages sent from provider
apps continue normally. WhatsApp history requests, resync, media downloads, and
their shared request/connection machinery remain active.

Hook samples no longer include `message.sent`. Loading a legacy hook config
ignores that event while retaining its other hooks; the file is not rewritten.
Other unknown event names still fail validation.

`src/db/retired-queues-compatibility.test.ts` seeds every legacy queue status in
the current canonical bootstrap with migration ledgers through `0014_jobs_table`
and through the latest migration. The partial ledger exercises subsequent
migrations against retained queue rows; it is not a frozen historical schema.
It verifies exact rows, table/index definitions, and migration ledger retention
through migration, active sync and sent-message projection/search, and reopening
the database. This protects storage compatibility without preserving tests of
the removed queue implementation.
