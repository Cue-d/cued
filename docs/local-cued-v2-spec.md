# Local Cued V2 Spec

## Purpose

Build `cued` as a local-first daemon and CLI that continuously syncs messages and contacts from multiple platforms into one SQLite database. The database is the primary agent interface. Agents reason over it with SQL and shell code. The core system avoids fuzzy heuristics and avoids destructive writes.

## Product Shape

- No Electron client.
- No cloud backend.
- No Cued auth.
- No UI requirement.
- One local database per machine profile.
- One long-running daemon plus a local CLI.
- SQLite is the source of truth for all synced and projected data.
- Agents get direct SQL access to the DB and a skill that teaches query patterns.

## Naming

- Binary: `cued`
- Daemon mode: `cued daemon`
- Launchd should run `cued daemon` on login by default.
- DB path: `~/.cued/local.db`
- Socket path: `~/.cued/cued.sock`
- Log path: `~/.cued/logs/`

## Goals

- Continuously sync all supported messaging/contact sources into one local DB.
- Support deterministic cross-platform contact merging.
- Preserve replayability through append-only raw ingest.
- Preserve participant history within conversations.
- Preserve edits, deletes, read receipts, delivery receipts, and reactions.
- Make the schema easy for agents to query directly.
- Keep the daemon as the only DB writer.
- Keep network access constrained to source integrations only.

## Non-Goals

- No fuzzy auto-merge in core.
- No LLM-specific tool API layer in v1.
- No attachment downloading in v1.
- No encryption at rest in v1.
- No outbound messaging/actions in v1.
- No automatic merge suggestions created by the core.

## High-Level Architecture

### Components

- `cued daemon`
  - Owns scheduler, adapter lifecycle, checkpoints, ingest, projection, rebuilds, and local IPC.
  - Is the only process that writes to SQLite.

- `cued` CLI
  - Talks to the daemon over a local Unix socket.
  - Provides operational commands such as status, logs, rebuild, reset, and manual merge.

- Swift macOS adapters
  - Used only where native/macOS access is the right tool.
  - Initial targets: iMessage/Messages DB access, Contacts.app integration, future native macOS sources.

- TypeScript browser-session adapters
  - Used for LinkedIn, Slack, Discord, WhatsApp Web, Gmail web, and similar browser-backed integrations.
  - Run as child workers supervised by the daemon.

- SQLite database
  - Stores append-only raw ingest, normalized event rows, projected query tables, and operational state.

### Process Boundaries

- The daemon owns all scheduling and writes.
- Adapters emit envelopes to the daemon over stdio or JSON-RPC.
- Adapters do not write to SQLite directly.
- The daemon persists raw ingest first, then runs projection.

## Language Split

- Daemon and CLI: TypeScript
- Browser-session adapters: TypeScript
- macOS-native adapters: Swift

This keeps the browser automation ecosystem intact while moving native platform access into Swift where it belongs.

## Data Flow

1. Adapter starts under daemon supervision.
2. Adapter loads its checkpoint from the daemon.
3. Adapter fetches full or incremental source data.
4. Adapter emits append-only raw event envelopes.
5. Daemon writes raw events in order and updates ingest watermark.
6. Projector transforms raw events into normalized event tables.
7. Projector updates canonical contact, conversation, participant, and message projections.
8. Projector updates FTS and stable read views.
9. Daemon updates projection watermark.

## Sync Model

### General Rules

- Each source/account has its own checkpoint.
- Full sync should happen once per source/account unless reset is requested.
- Incremental sync is the default after full sync.
- Realtime should be used when the adapter can do it safely.
- Polling remains the fallback for sources without reliable realtime.
- Rebuilds should replay from raw ingest, not re-fetch from the network.

### Checkpoint Requirements

Each checkpoint must track:

- source platform
- account/workspace identity
- source cursor payload JSON
- last successful full sync time
- raw ingest watermark
- projection watermark
- sync mode
- last success time
- last error time
- last error summary

This separates source progress from projection progress and makes rebuilds safe.

## SQLite Model

### Principle

Use append-only ingest plus rebuildable projections.

### Table Families

#### Operational

- `source_accounts`
- `sync_checkpoints`
- `sync_runs`
- `sync_run_errors`
- `daemon_state`

#### Append-Only Raw Ingest

- `raw_events`
- `raw_blobs` if a source requires oversized payload spillover later

#### Normalized Event Layer

- `contact_observations`
- `conversation_observations`
- `message_events`
- `message_reactions`
- `participant_events`

#### Canonical Projected Layer

- `contacts`
- `contact_handles`
- `contact_field_values`
- `contact_sources`
- `contact_merge_decisions`
- `conversations`
- `conversation_participants`
- `messages`
- `messages_fts`

#### Stable Read Views

- `contact_directory`
- `conversation_directory`
- `message_timeline`
- `message_search_results`
- `contact_provenance_summary`
- `message_reaction_summary`

## Raw Ingest Schema

### `raw_events`

Append-only source log. One row per observed source event or source snapshot envelope.

Columns:

- `id`
- `platform`
- `account_key`
- `entity_kind`
- `event_kind`
- `external_event_id`
- `external_entity_id`
- `conversation_external_id`
- `occurred_at`
- `observed_at`
- `cursor_json`
- `dedupe_key`
- `payload_json`
- `source_version`

Rules:

- `payload_json` stores the original source payload or normalized source snapshot.
- `dedupe_key` prevents duplicate ingest on retries.
- Raw rows are never edited or deleted.

## Normalized Event Schema

### `message_events`

Normalized append-only message state transitions.

Columns:

- `id`
- `platform`
- `account_key`
- `source_message_key`
- `source_conversation_key`
- `event_type`
- `event_at`
- `sender_source_key`
- `content_original`
- `content_current`
- `status_delivery`
- `deleted`
- `edited`
- `metadata_json`
- `raw_event_id`

Event types:

- `message_created`
- `message_edited`
- `message_deleted`
- `message_delivered`
- `message_read`
- `message_failed`
- `reaction_added`
- `reaction_removed`
- `participant_joined`
- `participant_left`

### `message_reactions`

Projected current reaction state by message.

Columns:

- `id`
- `message_id`
- `platform`
- `source_reaction_key`
- `emoji`
- `reactor_contact_id`
- `reactor_source_key`
- `is_active`
- `created_at`
- `updated_at`
- `raw_event_id`

### `participant_events`

Append-only membership changes for conversations.

Columns:

- `id`
- `platform`
- `account_key`
- `source_conversation_key`
- `participant_source_key`
- `event_type`
- `event_at`
- `metadata_json`
- `raw_event_id`

## Canonical Contact Schema

### `contacts`

One canonical cross-platform person/entity record.

Columns:

- `id`
- `kind`
- `preferred_display_name`
- `preferred_photo_url`
- `preferred_company`
- `archived`
- `created_at`
- `updated_at`

`contacts` is a projection. It stores the best current values for agent querying. Provenance lives in companion tables.

### `contact_handles`

All deterministic and human-facing identifiers.

Columns:

- `id`
- `contact_id`
- `handle_type`
- `value`
- `normalized_value`
- `platform_scope`
- `account_scope`
- `is_deterministic_key`
- `created_at`
- `updated_at`

Handle types include:

- `email`
- `phone`
- `imessage_handle`
- `slack_user_id`
- `linkedin_member_urn`
- `linkedin_profile_id`
- `discord_user_id`
- `whatsapp_phone`
- `signal_id`
- `twitter_user_id`
- `twitter_handle`
- `gmail_email`
- future stable source identifiers

Rules:

- Deterministic auto-merge only uses explicitly allowed deterministic handle types.
- Platform-local IDs merge only where that ID is actually stable and unique.
- Non-deterministic display handles never auto-merge contacts.

### `contact_field_values`

Field-level provenance store for projected contact fields.

Columns:

- `id`
- `contact_id`
- `field_name`
- `field_value`
- `platform`
- `account_key`
- `source_entity_key`
- `priority`
- `observed_at`
- `is_current_best`

Field names include:

- `display_name`
- `photo_url`
- `company`
- `headline`
- `bio`

Rules:

- Contacts.app is preferred for `display_name` and `photo_url`.
- Every source can contribute field candidates.
- The `contacts` table stores the current best value chosen from `contact_field_values`.

### `contact_sources`

Per-source identity linkage for each canonical contact.

Columns:

- `id`
- `contact_id`
- `platform`
- `account_key`
- `source_entity_key`
- `source_profile_url`
- `first_seen_at`
- `last_seen_at`
- `metadata_json`

### `contact_merge_decisions`

Manual merge/block decisions recorded by CLI and honored by projection.

Columns:

- `id`
- `decision_type`
- `left_contact_id`
- `right_contact_id`
- `canonical_contact_id`
- `reason`
- `created_by`
- `created_at`

Decision types:

- `merge`
- `block`
- `split`

Rules:

- The core does not generate fuzzy suggestions.
- Agents can decide merges.
- Reliable execution happens through CLI commands that append a decision row and trigger projection.
- Projection must honor manual `block` decisions and never auto-collapse those pairs.

## Canonical Conversation Schema

### `conversations`

One canonical conversation per platform thread. Conversations do not merge across platforms.

Columns:

- `id`
- `platform`
- `account_key`
- `source_conversation_key`
- `conversation_type`
- `display_name`
- `topic`
- `last_message_at`
- `last_message_preview`
- `unread_count`
- `created_at`
- `updated_at`

Rule:

- Cross-platform contact merge is allowed.
- Cross-platform conversation merge is not allowed.

### `conversation_participants`

Temporal participant membership projection.

Columns:

- `conversation_id`
- `contact_id`
- `role`
- `joined_at`
- `left_at`
- `is_active`
- `source_participant_key`
- `updated_at`

Rules:

- Membership history must be preserved.
- Group participant changes should not create a new canonical conversation by default.

## Canonical Message Schema

### `messages`

Latest-state message projection optimized for direct SQL.

Columns:

- `id`
- `platform`
- `account_key`
- `source_message_key`
- `conversation_id`
- `sender_contact_id`
- `sender_source_key`
- `sent_at`
- `content_original`
- `content_current`
- `status_delivery`
- `delivered_at`
- `read_at`
- `edited_at`
- `deleted_at`
- `is_deleted`
- `is_edited`
- `has_attachments`
- `attachment_metadata_json`
- `reaction_count`
- `created_at`
- `updated_at`

### Why keep some state on `messages`

It is good to keep delivery/read/edit/delete convenience fields on `messages`.

It is not good to make `messages` the only source of truth for those transitions.

Decision:

- `messages` stores latest-state convenience columns for easy agent SQL.
- `message_events` stores the append-only source of truth.
- `message_reactions` stores the current projected reaction state.

### Reaction storage decision

Do not store reactions only as JSON on `messages`.

Use:

- `message_reactions` for queryable active reactions
- `reaction_count` on `messages` as a convenience projection
- optional `message_reaction_summary` view for agent readability

This keeps SQL sane and preserves replayability.

## Views Exposed To Agents

### `contact_directory`

Purpose:

- Fast contact lookup by name/company/last activity.

Should include:

- contact id
- preferred display name
- preferred company
- preferred photo URL
- aggregated handles
- aggregated source platforms
- last message time

### `conversation_directory`

Purpose:

- Fast thread lookup with participant names.

Should include:

- conversation id
- platform
- display name
- participant names
- last message preview
- last message time
- unread count

### `message_timeline`

Purpose:

- Human-readable message listing joined with contact and conversation context.

Should include:

- message id
- platform
- sender name
- conversation name
- participant names
- content current
- sent_at
- delivery/read/edit/delete convenience fields

### `message_search_results`

Purpose:

- FTS-backed search view for topics and people.

Should join:

- `messages`
- `messages_fts`
- sender/conversation projections

### `contact_provenance_summary`

Purpose:

- Help agents explain why a canonical contact exists and which fields came from where.

### `message_reaction_summary`

Purpose:

- Show current reactions per message without forcing agents to build a group aggregation query.

## Deterministic Merge Rules

### Auto-merge allowed

- Same normalized email
- Same normalized phone
- Same stable source identity when that identity is globally meaningful or account-scoped meaningful
- Same LinkedIn member/profile ID or URN
- Same Slack user ID within the same workspace
- Same Discord user ID
- Same WhatsApp phone
- Same Signal account/phone
- Same iMessage phone/email handle
- Same Gmail email

### Auto-merge forbidden

- Exact same display name
- Similar display name
- Shared company only
- Shared profile photo only
- Shared message thread only
- Shared inferred relationship only

### Manual merge behavior

- Agent/user identifies candidates.
- CLI records a `merge` or `block` decision.
- Projector rebuilds canonical contact state.

## Contacts Source Priority

For projected preferred fields:

- `display_name`: prefer Contacts.app, then platform-specific profile names
- `photo_url`: prefer Contacts.app, then platform-specific profile photos
- `company`: prefer explicit source company/headline fields, then preserve latest known non-empty value

Contacts.app is not the only source. It is simply the preferred source for human display name and photo.

## Attachments

V1 attachment policy:

- Never download attachment bytes.
- Preserve optimistic URLs or local file paths only when the source surfaces them.
- Store attachment metadata JSON on `messages`.
- Preserve any structured attachment metadata in raw ingest.

## Delete Policy

- Preserve original content in raw ingest.
- Preserve original content in the message projection.
- Mark projected messages as deleted with `is_deleted` and `deleted_at`.
- Allow agents to see deletion history.

## Privacy And Local Security

- No DB encryption in v1.
- DB file permissions should be private to the user.
- Daemon socket must be local-only.
- No remote telemetry.
- No network calls except platform adapters.
- Rebuild/reset are manual CLI operations, not skill operations.

## CLI Surface

Required commands:

- `cued help`
- `cued daemon`
- `cued status`
- `cued logs`
- `cued sync run [source]`
- `cued sync resume`
- `cued rebuild`
- `cued reset --source <source>`
- `cued merge contact <left> <right>`
- `cued split contact <contact>`
- `cued doctor`

Behavior:

- CLI performs reliable operations.
- CLI does not become the primary query interface for agents.
- Agents should use SQL directly against SQLite.

## Skill Contract

The skill should teach:

- DB path
- stable views
- pagination patterns
- FTS search
- participant filtering
- provenance inspection
- how to reason about duplicates without fuzzy core logic
- optional web enrichment after local evidence identifies the likely person

The skill should not:

- expose hidden heuristics
- assume bespoke tool APIs
- run destructive maintenance commands

## Initial Source Plan

Keep in scope:

- iMessage
- Contacts.app
- Slack
- LinkedIn messaging
- Signal
- Discord
- Gmail
- WhatsApp Web

Defer risky relationship scraping:

- Twitter followers/following scraping
- LinkedIn follower/following style scraping

Reason:

- High ban risk
- Lower value than direct message and contact sync
- Not required for the core bridge-across-platforms product

## Repo Shape

Recommended target structure:

- `apps/cued/`
  - daemon
  - CLI
  - projector
  - scheduler
  - IPC server
  - browser-session workers
- `native/macos/CuedNative/`
  - Swift Package
  - Messages adapter
  - Contacts adapter
  - future native macOS integrations
- `docs/`
  - architecture and schema docs
- `skills/cued/`
  - SQL-first agent skill

## Migration Strategy From Current Local Mode

1. Keep the SQLite schema work as a seed, not as the final architecture.
2. Stop adding more logic to Electron-specific sync managers.
3. Extract platform mapping logic into adapter workers.
4. Introduce append-only raw ingest and projection watermarks.
5. Move operational entrypoints to `apps/cued`.
6. Replace the current local-mode Electron runtime with `cued daemon`.
7. Keep the SQL-first skill and evolve it against the new stable views.

## Build Order

1. Scaffold `apps/cued` daemon and CLI.
2. Define SQLite migrations for operational, raw, normalized, and projected tables.
3. Implement daemon-owned write path and projector.
4. Port iMessage and Contacts to Swift adapters.
5. Port existing local sync logic into daemon-supervised adapters.
6. Add launchd integration.
7. Rebuild the skill against final stable views.
8. Add fixture DBs and benchmark corpus for skill evaluation.

## Decision Summary

- One daemon-owned SQLite writer
- Append-only raw ingest
- Rebuildable projections
- Deterministic contact merge only
- No fuzzy auto-merge
- Manual merge/block via CLI
- Field-level provenance
- Temporal conversation participants
- Latest-state convenience columns on `messages`
- Append-only `message_events` as truth
- Separate `message_reactions`
- No conversation merge across platforms
- Contacts.app preferred for display name and photo
- No attachment download in v1
- No DB encryption in v1
