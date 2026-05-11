# Launch responsiveness

Cued launch sync must show local value quickly without making the menu bar app, onboarding UI, or auth flows feel blocked. The launch path should prefer one SQLite database until measured evidence shows the database boundary itself is the bottleneck.

## Current architecture

- The daemon owns UI, IPC, auth orchestration, realtime supervisors, and scheduling.
- iMessage backfill runs in a child ingest worker so native reads and raw-event inserts do not block the daemon event loop.
- Projection runs in a child projection worker. The daemon claims/monitors projection runs and keeps scheduling responsive.
- Status requests during background work prefer a fresh menu bar status snapshot. If the snapshot is stale, the daemon attempts a short SQLite read and falls back to the last cached snapshot only when SQLite is busy.
- Backfill pressure and recent interactive requests reduce ingest concurrency so auth and UI work keep priority.
- SQLite busy/locked failures reschedule the affected sync/projection run instead of failing or wedging the queue.

## Success targets

- UI/status latency during first backfill: p95 under 500 ms.
- Auth kickoff during first backfill: browser or QR flow should start near the no-sync baseline.
- Projection keeps draining continuously and should stay above 10k raw events/min on older Macs unless the source reader is the limiting factor.
- Status counts must advance during backfill. Fast stale zero-count responses do not count as success.
- Permission changes should refresh without relaunch when possible, using bounded polling after permission requests, Settings guides, and app activation.

## Keep one database unless these fail

Do not split SQLite databases just to avoid occasional write locks. First exhaust these simpler controls:

- Move heavy source capture and bulk raw-event writes out of the daemon process.
- Keep projection off the daemon process.
- Keep status/UI reads mostly served from a fresh cache while background work is active.
- Coalesce projection runs and avoid large synchronous status rebuilds on user-triggered IPC paths.
- Use small busy timeouts plus run rescheduling for transient locks.
- Add worker ownership to any platform whose backfill can block the daemon.

## Multi-database fallback

Only revisit multiple SQLite databases if the one-database worker model still misses the targets after real smoke tests.

Candidate split:

- `local.db`: canonical raw events, projected contacts/conversations/messages, FTS, sync checkpoints, and agent query surface.
- `runtime.db`: daemon/auth/UI state, active auth sessions, permission snapshot cache, menu bar cache metadata, and transient sync run state.

Benefits:

- Auth/UI status writes cannot be blocked by large canonical-data writes.
- The daemon can remain responsive even if `local.db` has a long writer.
- Runtime state can use smaller, simpler tables and more aggressive cleanup.

Costs:

- Agents and CLI paths may need to join information across files or use a broker API.
- Failure recovery becomes two-phase: a sync run in `runtime.db` may correspond to partial raw events in `local.db`.
- More migrations, backups, wipe/reset logic, packaging diagnostics, and support complexity.
- Cross-DB consistency bugs are harder to reason about than current SQLite busy handling.

Decision rule:

- Split only if OpenClaw-class smoke tests still show p95 UI/status latency above 500 ms or auth kickoff clearly worse than no-sync baseline after workerizing the blocking platform.
- If splitting, keep agent query data in one canonical `local.db`; do not require agents to query multiple databases directly. Route runtime metadata through CLI/daemon status APIs.
