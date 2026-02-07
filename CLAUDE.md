# CLAUDE.md - Cued Codebase Guide

## What This Is

Cued is a cloud-based personal relationship manager. Multi-platform messaging (iMessage, Gmail, Slack, LinkedIn) with AI-powered action suggestions.

## Architecture

```
apps/web (Next.js 16) ←→ packages/convex (Convex) ←→ Nango (Gmail)
                                    ↑
                          ┌─────────┴─────────┐
apps/electron (macOS) ────┤                   │
  ├── iMessage sync       │   Cloud Cursors   │
  ├── LinkedIn sync       │   (syncCursors)   │
  ├── Slack sync          │                   │
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
  electron/         macOS sync client (iMessage, LinkedIn, Slack, Contacts)

packages/
  shared/           Source of truth for utils, types, constants (@cued/shared)
  ui/               Shared React components (@cued/ui)
  convex/           Database schema + functions (@cued/convex)
  ai/               LLM tools, action generation (@cued/ai)
  integrations/     iMessage, Slack, Nango adapters (@cued/integrations)
```

### packages/shared (Source of Truth)

All shared utilities, types, and constants live here. Import from `@cued/shared`:

- **Utils**: `getInitials`, `formatTime`, `formatRelativeTime`, `formatTimestamp`
- **Phone**: `normalizePhone`, `formatPhoneNumber`, `phonesMatch`, `getPhoneVariants`
- **LinkedIn**: `normalizeLinkedInHandle`, `extractLinkedInURN`, `isValidLinkedInURN`, `parseLinkedInURN`
- **Types**: `DisplayMessage`, `ContactFormData`, `EnrichedAction`, `ContactHandle`, `HandleType`
- **Constants**: `PLATFORM_CONFIG`, `ActionPlatform`, `ACTION_TYPES`, `isMessageActionType`, `isContactActionType`

### packages/ui Component Organization

```
components/
  action-queue/           Action card components
    message-response-card/  Split into sub-components (PlatformBadge, MessageBubble, etc.)
    contact-card.tsx
    card-stack.tsx
    swipeable-card.tsx
  assistant/              AI chat components (chat-input, chat-message, tool-artifact)
  unified-inbox/          Inbox components (conversation-item, platform-badge)
  contacts/               Contact management (merge-card)
  ui/                     shadcn/ui primitives
```

### packages/convex Sync Architecture

Sync logic is modularized by platform with separated concerns:

```
convex/
  sync.ts              Orchestrator (exports public API)
  syncCursors.ts       Cloud-based cursor management (multi-device sync)
  debug.ts             Debug queries and platform-specific data reset utilities
  sync/
    shared.ts          Common utilities (handle resolution, contact creation, cursor helpers)
    filters.ts         Message filtering (OTP, spam, phishing detection)
    imessage.ts        iMessage and macOS Contacts sync
    gmail.ts           Gmail emails and Google Contacts sync
    slack.ts           Slack messages sync
    linkedin.ts        LinkedIn messages sync
```

**Key Design Principles:**

1. **Separation of concerns**: `integrations` table = connection state, `syncCursors` table = sync state
2. **Cloud cursors**: Sync state stored in Convex (not local files), enabling multi-device sync
3. **Multi-workspace support**: Gmail/Slack use `workspaceId` for multiple accounts per platform
4. **Message filtering**: Unified filtering rules applied during sync (OTP codes, automated senders, phishing)

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
| Message filtering | `packages/convex/convex/sync/filters.ts` |
| Debug/reset utils | `packages/convex/convex/debug.ts` |
| Actions queue | `packages/convex/convex/actions.ts`, `actionQueue.ts` |
| Shared utils/types | `packages/shared/src/` |
| LinkedIn utils | `packages/shared/src/linkedin.ts` |
| Contact resolution | `packages/ai/src/contact-resolution/` |
| LLM tools | `packages/ai/src/tools/` |
| AI chat UI | `packages/ui/src/components/assistant/` |
| Unified inbox | `packages/ui/src/components/unified-inbox/` |
| Action cards | `packages/ui/src/components/action-queue/` |
| Gmail/Slack | `packages/integrations/src/nango/` |
| iMessage sync | `apps/electron/src/main/sync/` |
| LinkedIn sync | `apps/electron/src/main/sync/linkedin-sync.ts` |
| Slack sync | `apps/electron/src/main/sync/slack-sync.ts` |
| Sync coordinator | `apps/electron/src/main/sync/sync-coordinator.ts` |
| Swift contacts CLI | `apps/electron/swift/` |
| Web routes | `apps/web/app/(app)/`, `app/api/` |
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
1. Check `packages/shared/src/` for existing utils (phone, linkedin, time)
2. Check `packages/convex/convex/sync/shared.ts` for sync utils
3. Check `apps/electron/src/main/sync/shared.ts` for electron sync utils

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
| Cursor management | `packages/convex/convex/sync/shared.ts` |

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

**Sync Components:**
- `sync-coordinator.ts` - Orchestrates all platform syncs
- `sync-manager.ts` - Core sync state machine
- `linkedin-sync.ts` - LinkedIn messages via web scraping
- `slack-sync.ts` - Slack messages via native API
- `contacts-sync.ts` - macOS Contacts.app integration
- `chat-db.ts` - iMessage SQLite database access

Swift contacts CLI: `apps/electron/swift/`
Build Swift: `cd apps/electron/swift && swift build -c release`

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Convex types missing | Run `cd packages/convex && pnpm dev` once |
| Swift build fails | Requires macOS 15+ and Swift 6.0+ |


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

# View issues
pnpm prd list                      # List open GitHub issues
pnpm prd view 123                  # View issue #123
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