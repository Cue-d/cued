# CLAUDE.md - Cued Codebase Guide

## What This Is

Cued is a cloud-based personal relationship manager. Multi-platform messaging (iMessage, Slack, LinkedIn, Signal, Twitter) with AI-powered action suggestions.

## Architecture

```
apps/web (Next.js 16) ←→ packages/convex (Convex)
                                    ↑
                          ┌─────────┴─────────┐
apps/electron (macOS) ────┤                   │
  ├── iMessage sync       │   Cloud Cursors   │
  ├── LinkedIn sync       │   (syncCursors)   │
  ├── Slack sync          │                   │
  ├── Signal sync         │                   │
  ├── Twitter sync        │                   │
  └── macOS Contacts      └───────────────────┘
```

**Data Flow:**
- Electron → Convex: Messages, conversations, contacts synced via mutations
- Convex → Electron: Sync cursors queried for incremental sync resume
- Web/Mobile → Convex: Real-time subscriptions for UI updates

## Monorepo Structure

```
apps/
  web/              Next.js app (marketing + authenticated app)
  mobile/           Expo React Native app (iOS)
  electron/         macOS sync client (iMessage, LinkedIn, Slack, Signal, Twitter, Contacts)

packages/
  shared/           Source of truth for utils, types, constants (@cued/shared)
  ui/               Shared React components (@cued/ui)
  convex/           Database schema + functions (@cued/convex)
  ai/               LLM tools, action generation, filters (@cued/ai)
  env/              Typed environment variable schemas (@cued/env)
  integrations/     iMessage adapters (@cued/integrations)
```

### packages/shared (Source of Truth)

All shared utilities, types, and constants live here. Import from `@cued/shared`:

- **Utils**: `getInitials`, `truncate`, `formatTime`, `formatRelativeTime`, `formatTimestamp`
- **Phone**: `normalizePhone`, `formatPhoneNumber`, `phonesMatch`, `getPhoneVariants`
- **LinkedIn**: `normalizeLinkedInHandle`, `isValidLinkedInHandle`, `extractLinkedInThreadId`, `normalizeConversationURN`, `normalizeMemberURN`, `isLinkedInURN`, `urnIdsMatch`
- **Deeplinks**: `buildHandleDeeplink`, `getPlatformDeeplink`, `getContactDeeplink`, `getOpenInAppLabel`
- **Analytics**: `ANALYTICS_EVENTS` with typed event properties
- **Types**: `DisplayMessage`, `ContactFormData`, `EnrichedAction`, `ContactHandle`, `HandleType`
- **Constants**: `PLATFORM_CONFIG`, `ActionPlatform`, `ACTION_TYPES`, `isMessageActionType`, `isContactActionType`
- **Action Registry** (preferred over legacy constants): `ACTION_REGISTRY`, `getActionMetadata`, `getActionDefinition`, `isMessageAction`, `isContactAction`
- **Embeddings**: `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `SIMILARITY_THRESHOLD`
- **Platform Adapters**: `SendResult`, `QueuedMessage`, `PlatformAdapter` types

### packages/ui Component Organization

```
components/
  action-queue/           Action card components
    message-response-card/  Split into sub-components (PlatformBadge, MessageBubble, ResponseInput)
    contact-card.tsx
    action-filter-dropdown.tsx
    action-filter-chips.tsx
    open-in-app-button.tsx
    SnoozePicker.tsx
  assistant/              AI chat components (chat-input, chat-message, tool-artifact, assistant-view, mentions)
  unified-inbox/          Inbox components (conversation-item, conversation-list, message-thread, platform-badge)
  three-panel-layout/     Reusable three-panel layout component
  ui/                     shadcn/ui primitives
  cued-mark.tsx           Cued logomark component
  platform-icons.tsx      Platform icon mappings
  command-menu.tsx        Command palette
  send-message-modal.tsx  Message sending modal
  message-queue-status.tsx  Queue status indicator
hooks/
  use-animated-icon.ts    Animated icon hook
  use-in-view-loop.ts     Intersection observer loop
```

### packages/convex Sync Architecture

Sync logic is modularized by platform with separated concerns:

```
convex/
  sync.ts              Orchestrator (exports public API)
  syncCursors.ts       Cloud-based cursor management (multi-device sync)
  debug.ts             Debug queries and platform-specific data reset utilities
  actions.ts           Action queue + action history queries
  actionQueue.ts       Queue processing and scheduling
  actionAnalysis.ts    Action similarity/embedding analysis
  actionEvents.ts      Action event tracking
  contactResolution.ts Contact merge/resolution logic
  messageQueue.ts      Outbound message queue
  search.ts            Full-text search queries
  lib/                 Internal helpers (cursors, normalizeHandle, queueMerge, actionSummary, etc.)
  swipeHandlers/       Per-action-type swipe logic (message, newConnection, resolveContact, eodContact)
  sync/
    shared.ts          Common utilities (handle resolution, contact creation, cursor helpers)
    imessage.ts        iMessage and macOS Contacts sync
    slack.ts           Slack messages sync
    linkedin.ts        LinkedIn messages sync
    signal.ts          Signal messages sync
    twitter.ts         Twitter/X messages sync
    batchUtils.ts      Batch fetch helpers
```

**Note:** Message filtering (OTP, spam, phishing) lives in `packages/ai/src/filters/`, not in convex.

**Key Design Principles:**

1. **Separation of concerns**: `integrations` table = connection state, `syncCursors` table = sync state
2. **Cloud cursors**: Sync state stored in Convex (not local files), enabling multi-device sync
3. **Multi-workspace support**: Slack uses `workspaceId` for multiple workspaces per platform
4. **Message filtering**: Unified filtering in `packages/ai/src/filters/` (OTP codes, automated senders, phishing, priority scoring)

**syncCursors Table Schema:**
```typescript
{
  userId, platform, workspaceId?,     // Identity
  cursorData,                         // Platform-specific (historyId, timestamp, etc.)
  syncMode: "full" | "incremental",   // Current sync mode
  fullSyncProgress?,                  // For resumable full syncs
  totalMessagesSynced?, totalContactsSynced?,  // Stats
}
```

## Quick Start

```bash
pnpm install
pnpm dev
```

Web app: http://localhost:3000

## Key Files

| Feature | Files |
|---------|-------|
| Database schema | `packages/convex/convex/schema.ts` |
| Sync logic | `packages/convex/convex/sync.ts`, `sync/*.ts` |
| Sync cursors | `packages/convex/convex/syncCursors.ts`, `sync/shared.ts` |
| Message filtering | `packages/ai/src/filters/message-filter.ts`, `priority.ts` |
| Debug/reset utils | `packages/convex/convex/debug.ts` |
| Actions queue | `packages/convex/convex/actions.ts`, `actionQueue.ts` |
| Swipe handlers | `packages/convex/convex/swipeHandlers/` |
| Convex internal helpers | `packages/convex/convex/lib/` |
| Shared utils/types | `packages/shared/src/` |
| LinkedIn utils | `packages/shared/src/linkedin.ts` |
| Deeplink utils | `packages/shared/src/deeplinks.ts`, `deeplinks-core.ts`, `deeplinks.native.ts` |
| Analytics events | `packages/shared/src/analytics.ts` |
| Action registry | `packages/shared/src/actions/registry.ts` |
| Env schemas | `packages/env/src/` (server, client, convex, electron) |
| Contact resolution | `packages/ai/src/contact-resolution/` |
| Action generation | `packages/ai/src/actions/generate-action.ts` |
| LLM tools | `packages/ai/src/tools/` |
| AI prompts | `packages/ai/src/prompts/system.ts` |
| Embeddings | `packages/ai/src/embeddings/` |
| AI chat UI | `packages/ui/src/components/assistant/` |
| Unified inbox | `packages/ui/src/components/unified-inbox/` |
| Action cards | `packages/ui/src/components/action-queue/` |
| Sync engine | `apps/electron/src/main/sync/engine.ts`, `sync-functions.ts` |
| Sync state machines | `apps/electron/src/main/sync/machines/orchestrator.ts`, `sync-actor.ts` |
| iMessage platform | `apps/electron/src/main/platforms/imessage/` |
| LinkedIn platform | `apps/electron/src/main/platforms/linkedin/` |
| Slack platform | `apps/electron/src/main/platforms/slack/` |
| Signal platform | `apps/electron/src/main/platforms/signal/` |
| Twitter platform | `apps/electron/src/main/platforms/twitter/` |
| Contacts platform | `apps/electron/src/main/platforms/contacts/` |
| Electron renderer | `apps/electron/src/renderer/pages/` (ActionsPage, ContactsPage, AssistantPage, SettingsPage) |
| Web routes | `apps/web/app/(app)/`, `app/(marketing)/`, `app/api/`, `app/download/` |
| Mobile routes | `apps/mobile/app/` |

## Behaviors

### DO

- Use `@cued/*` for monorepo packages (`@cued/shared`, `@cued/ui`, `@cued/convex`)
- Use `@/` path aliases for app-local imports
- Import shared utils/types from `@cued/shared` (not local definitions)
- Run relevant tests for changed packages before creating a PR.

### DON'T

- Don't modify Convex `_generated/` files
- Don't duplicate utilities that exist in `@cued/shared`

### Creating PRs

Before creating a PR, run the relevant tests for the packages you changed:

```bash
cd packages/convex && pnpm test     # Convex schema/function changes
cd packages/shared && pnpm test     # Shared utils/types changes
cd packages/ui && pnpm test         # UI component changes
cd apps/mobile && pnpm test         # Mobile app changes
cd apps/web && pnpm test:e2e        # Web app E2E tests (if UI/routing changed)
```

The pre-commit hook enforces `pnpm typecheck`, `pnpm lint`, and Convex tests. You don't need to run those manually — they run automatically on commit.

### Preventing Code Duplication

**Before creating types/interfaces:**
1. Check `packages/shared/src/types/` for existing definitions
2. If adding contact, message, or action types → use `@cued/shared`

**Before creating utilities:**
1. Check `packages/shared/src/` for existing utils (phone, linkedin, time, deeplinks, analytics)
2. Check `packages/convex/convex/sync/shared.ts` for sync utils
3. Check `packages/convex/convex/lib/` for convex internal helpers
4. Check `packages/ai/src/filters/` for message filtering utils

**Canonical type locations:**
| Type | Location |
|------|----------|
| `ContactHandle`, `HandleType` | `@cued/shared/types/contact` |
| `DisplayMessage`, `EnrichedAction` | `@cued/shared/types/actions` |
| `ACTION_TYPES`, `isMessageActionType` | `@cued/shared/constants/actions` |
| `PLATFORM_CONFIG`, `ActionPlatform` | `@cued/shared/constants/platform` |

**Sync code patterns:**
| Pattern | Location |
|---------|----------|
| `batchFetchConversations`, `batchFetchMessages` | `packages/convex/convex/sync/batchUtils.ts` |
| `getOrCreateContact`, `batchResolveHandles` | `packages/convex/convex/sync/shared.ts` |
| Cursor management | `packages/convex/convex/lib/cursors.ts` |
| Message queue insert | `packages/convex/convex/lib/queueMessageInsert.ts` |
| Handle normalization | `packages/convex/convex/lib/normalizeHandle.ts` |
| Contact merge scheduling | `packages/convex/convex/lib/contactMergeScheduling.ts` |
| Swipe handler registry | `packages/convex/convex/swipeHandlers/registry.ts` |

**Time formatting:**
- Use `formatRelativeTime` from `@cued/shared` (supports `{ allowFuture: true }` for future times)
- Use `formatTimestamp` for smart date/time formatting
- Don't create local formatRelativeTime functions

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps/packages in dev mode |
| `pnpm build` | Build everything |
| `pnpm lint` | Lint all packages |
| `pnpm typecheck` | Type check all packages |
| `pnpm test` | Run all tests |

## Testing

All packages use **Vitest** for unit tests. Coverage goals:

| Package | Goal | Test Files |
|---------|------|------------|
| packages/shared | >90% | `src/**/__tests__/*.test.ts` |
| packages/ui | >80% | `src/components/**/__tests__/*.test.tsx` |
| packages/convex | >50% | `convex/__tests__/*.test.ts` |
| apps/mobile | >50% | `src/**/__tests__/*.test.ts(x)` |

```bash
pnpm test                           # All tests (Vitest)
cd apps/web && pnpm test:e2e        # E2E tests (Playwright)
cd packages/convex && pnpm test     # Convex tests (uses convex-test)
```

### Convex Testing

Uses `convex-test` library with edge-runtime environment:

```typescript
import { convexTest } from "convex-test"
import schema from "../schema"

const t = convexTest(schema)
await t.mutation(api.actions.createAction, { ... })
```

## Convex

```bash
cd packages/convex
pnpm dev      # Start Convex dev server
pnpm build    # Deploy to production
```

Schema: `packages/convex/convex/schema.ts`
Functions: `packages/convex/convex/*.ts`

## Electron (macOS)

```bash
cd apps/electron
pnpm dev      # Start Electron in dev mode
pnpm build    # Build distributable
```

**Sync Architecture:**
- `sync/engine.ts` - Core sync engine
- `sync/sync-functions.ts` - Sync function implementations
- `sync/machines/orchestrator.ts` - Orchestrates all platform syncs
- `sync/machines/sync-actor.ts` - State machine for individual sync actors
- `sync/cursor.ts` - Cursor management
- `sync/guard.ts` - Sync guards/conditions
- `sync/presence.ts` - Presence tracking
- `sync/history-cutoff.ts` - History cutoff logic

**Platform Adapters** (`platforms/<name>/`):
Each platform has `sync.ts`, `adapter.ts`, `auth.ts`, `index.ts`, and platform-specific API clients:
- `imessage/` - iMessage via SQLite (`chat-db.ts`) + attributed body parsing
- `linkedin/` - LinkedIn via internal API (`api/client.ts`) + scraper
- `slack/` - Slack via native API (`api/client.ts`)
- `signal/` - Signal via daemon client
- `twitter/` - Twitter/X via API + scraper
- `contacts/` - macOS Contacts via `node-mac-contacts` native module

**Renderer Pages** (`renderer/pages/`):
- `ActionsPage.tsx` - Action queue with history view and infinite scroll
- `ContactsPage.tsx` - Contact management with swipeable list
- `AssistantPage.tsx` - AI assistant chat
- `SettingsPage.tsx` - App settings

**Contacts:** Uses `node-mac-contacts` native module (not Swift CLI). Provides in-process access to macOS Contacts.app via CNContactStore. Permission requests, contact fetching, and change listening all happen in the Electron main process.

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Convex types missing | Run `cd packages/convex && pnpm dev` once |
| `node-mac-contacts` build fails | Needs `node-addon-api@^8` override (see root package.json pnpm.overrides) |


## Ralph System (GitHub Issues → Claude)

GitHub issues ARE the PRDs. No separate PRD files needed.

### Workflow

```
/write-a-prd → GitHub Issue → ralph-once.sh → Claude → Commit → Close Issue
```

1. **Create PRD**: Run `/write-a-prd` skill - guides through problem discovery, solution design, creates GitHub issue
2. **Execute**: Ralph scripts fetch issues via `gh issue list`, pass to Claude with `prds/prompt.md`
3. **Implement**: Claude picks highest-priority issue, implements, commits
4. **Complete**: Progress logged to `progress.txt`, issue closed

### Commands

```bash
# Create PRD (in Claude Code)
/write-a-prd

# Execute
./ralph-once.sh                    # Single iteration (HITL)
./ralph-once.sh --issue 123        # Target specific issue
./ralph-once.sh --sandbox          # Docker sandbox (mounts ~/.claude for OAuth)
./ralph-once.sh --port 3001        # Custom dev server port

./afk-ralph.sh 10                  # 10 iterations (AFK)
./afk-ralph.sh 10 --issue 123      # Target specific issue

# View issues (from scripts/ directory)
cd scripts && pnpm prd list        # List open GitHub issues
cd scripts && pnpm prd view 123    # View issue #123
```

Worktrees managed by Conductor via `conductor.json`.

### Key Files

| File | Purpose |
|------|---------|
| `prds/prompt.md` | Execution instructions for Claude |
| `progress.txt` | Log of completed work |
| `.claude/skills/write-a-prd/SKILL.md` | PRD creation skill |

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.