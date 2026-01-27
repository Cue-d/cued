# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a cloud-based personal relationship manager. Multi-platform messaging (iMessage, Gmail, Slack, LinkedIn) with AI-powered action suggestions.

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
  shared/           Source of truth for utils, types, constants (@prm/shared)
  ui/               Shared React components (@prm/ui)
  convex/           Database schema + functions (@prm/convex)
  ai/               LLM tools, Mem0 integration (@prm/ai)
  integrations/     iMessage, Slack, Nango adapters (@prm/integrations)
```

### packages/shared (Source of Truth)

All shared utilities, types, and constants live here. Import from `@prm/shared`:

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
  lastMemoryProcessedAt?, totalMemoriesExtracted?  // Memory processing
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

- Use `@prm/*` for monorepo packages (`@prm/shared`, `@prm/ui`, `@prm/convex`)
- Use `@/` path aliases for app-local imports
- Import shared utils/types from `@prm/shared` (not local definitions)
- Run `pnpm lint && pnpm typecheck` before commits
- Use `pnpm dlx shadcn@latest add [component] --yes` to add UI components
- Verify shadcn imports use `@/` aliases after adding

### DON'T

- Don't use `"use client"` in packages/ui (it's a shared library)
- Don't modify Convex `_generated/` files
- Don't duplicate utilities that exist in `@prm/shared`

### Preventing Code Duplication

**Before creating types/interfaces:**
1. Check `packages/shared/src/types/` for existing definitions
2. If adding contact, message, or action types → use `@prm/shared`

**Before creating utilities:**
1. Check `packages/shared/src/` for existing utils (phone, linkedin, time)
2. Check `packages/convex/convex/sync/shared.ts` for sync utils
3. Check `apps/electron/src/main/sync/shared.ts` for electron sync utils

**Canonical type locations:**
| Type | Location |
|------|----------|
| `ContactHandle`, `HandleType` | `@prm/shared/types/contact` |
| `DisplayMessage`, `EnrichedAction` | `@prm/shared/types/actions` |
| `ACTION_TYPES`, `isMessageActionType` | `@prm/shared/constants/actions` |
| `PLATFORM_CONFIG`, `ActionPlatform` | `@prm/shared/constants/platform` |

**Sync code patterns:**
| Pattern | Location |
|---------|----------|
| `batchFetchConversations`, `batchFetchMessages` | `packages/convex/convex/sync/batch-utils.ts` |
| `getOrCreateContact`, `batchResolveHandles` | `packages/convex/convex/sync/shared.ts` |
| Cursor management | `packages/convex/convex/sync/shared.ts` |

**Time formatting:**
- Use `formatRelativeTime` from `@prm/shared` (supports `{ allowFuture: true }` for future times)
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


## Linear Integration & PRD Automation

We use Linear MCP to track features and automatically generate PRDs.

### One-Shot Command (PREFERRED)

When user says "work on PRM-123" or "start PRM-123":

```bash
cd scripts && pnpm prd start PRM-123
```

This single command:
1. Fetches Linear issue
2. Generates PRD with tasks + documentation refs
3. Updates Linear status → "In Progress"
4. Creates git branch `theotarr/prm-123-feature-name`

Add `--run` to immediately start executing tasks.

### PRD JSON Schema

Generated PRDs include documentation fields for AI context:

```json
{
  "project": "Feature Name",
  "linearIssueId": "PRM-123",
  "documentation": [
    {"url": "https://docs.example.com", "title": "API Docs", "reason": "Needed for X"}
  ],
  "reference_repos": [
    {"url": "https://github.com/foo/bar", "description": "Similar pattern"}
  ],
  "tasks": [...]
}
```

AI agents should **fetch these docs** before executing tasks.

### CLI Commands

| Command | Description |
|---------|-------------|
| `pnpm prd start PRM-123` | One-shot: pull + status + branch |
| `pnpm prd start PRM-123 --run` | Same + immediately run tasks |
| `pnpm prd pull PRM-123` | Just generate PRD |
| `pnpm prd run prds/prm-123-prd.json` | Execute tasks (Ralph loop) |
| `pnpm prd run prds/prm-123-prd.json --dry-run` | Show what would execute |
| `pnpm prd sync prds/prm-123-prd.json` | Sync progress to Linear |
| `pnpm prd status prds/prm-123-prd.json` | Show completion status |
| `pnpm prd link-pr PRM-123 <url>` | Link PR to issue |

### Ralph Shell Scripts

The Ralph scripts are thin wrappers for manual iteration:

```bash
./ralph-once.sh prds/slack-native-integration-prd.json  # Single iteration
./afk-ralph.sh prds/slack-native-integration-prd.json 10  # 10 afk iterations
```

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.