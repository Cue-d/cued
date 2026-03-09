# CLAUDE.md - Cued Codebase Guide

## What This Is

Cued is being rebuilt as a local-only message and contact datastore for agents. The product direction is `apps/cued` + `native/macos/CuedNative` + a local SQLite database at `~/.cued/local.db`.

## Architecture

```
native/macos/CuedNative (menu bar host, permissions, native windows)
        |
        v
apps/cued (daemon, auth/session model, sync orchestration, projection)
        |
        v
~/.cued/local.db
```

**Current state:**
- `apps/cued` is the canonical runtime
- `apps/electron` is reference-only during cutover
- cloud/web/mobile code is legacy and being removed

## Monorepo Structure

```
apps/
  cued/             Local daemon and CLI
  electron/         macOS sync client (iMessage, LinkedIn, Slack, Contacts)

packages/
  shared/           Source of truth for utils, types, constants (@cued/shared)
  ui/               Shared React components (@cued/ui)
  convex/           Database schema + functions (@cued/convex)
  ai/               LLM tools, action generation (@cued/ai)
  integrations/     iMessage adapters (@cued/integrations)
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
    slack.ts           Slack messages sync
    linkedin.ts        LinkedIn messages sync
```

**Key Design Principles:**

1. **Separation of concerns**: `integrations` table = connection state, `syncCursors` table = sync state
2. **Cloud cursors**: Sync state stored in Convex (not local files), enabling multi-device sync
3. **Multi-workspace support**: Slack uses `workspaceId` for multiple workspaces per platform
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
pnpm --dir apps/cued build
swift build --package-path native/macos/CuedNative -c release
```

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
| iMessage sync | `apps/electron/src/main/sync/` |
| LinkedIn sync | `apps/electron/src/main/sync/linkedin-sync.ts` |
| Slack sync | `apps/electron/src/main/sync/slack-sync.ts` |
| Sync coordinator | `apps/electron/src/main/sync/sync-coordinator.ts` |
| Contacts integration | `apps/electron/src/main/platforms/contacts/` |
| Local daemon | `apps/cued/src/daemon/`, `src/projector/`, `src/integrations/` |
| macOS host app | `native/macos/CuedNative/Sources/CuedNative/` |

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
cd apps/cued && pnpm test           # Local daemon/CLI changes
cd native/macos/CuedNative && swift test   # Native host changes when present
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
```bash
pnpm test                           # Workspace tests (Vitest)
cd apps/cued && pnpm test           # Local daemon tests
cd packages/convex && pnpm test     # Legacy cloud tests if touched
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

**Contacts:** Uses `node-mac-contacts` native module (not Swift CLI). Provides in-process access to macOS Contacts.app via CNContactStore. Permission requests, contact fetching, and change listening all happen in the Electron main process.

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Convex types missing | Run `cd packages/convex && pnpm dev` once |
| `node-mac-contacts` build fails | Needs `node-addon-api@^8` override (see root package.json pnpm.overrides) |


## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.
