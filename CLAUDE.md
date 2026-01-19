# CLAUDE.md - PRM Codebase Guide

## What This Is

PRM is a cloud-based personal relationship manager. Multi-platform messaging (iMessage, Gmail, Slack) with AI-powered action suggestions.

## Architecture

```
apps/web (Next.js 16) ←→ packages/convex (Convex) ←→ Nango (Gmail/Slack)
                                    ↑
apps/electron (macOS) ─── iMessage sync ───┘
```

## Monorepo Structure

```
apps/
  web/              Next.js app (marketing + authenticated app)
  mobile/           Expo React Native app (iOS)
  electron/         macOS sync client (iMessage, Contacts)

packages/
  shared/           Source of truth for utils, types, constants (@prm/shared)
  ui/               Shared React components (@prm/ui)
  convex/           Database schema + functions (@prm/convex)
  ai/               LLM tools, Mem0 integration (@prm/ai)
  integrations/     iMessage, Nango adapters (@prm/integrations)
```

### packages/shared (Source of Truth)

All shared utilities, types, and constants live here. Import from `@prm/shared`:

- **Utils**: `getInitials`, `formatTime`, `formatRelativeTime`, `formatTimestamp`
- **Phone**: `normalizePhone`, `formatPhoneNumber`, `phonesMatch`
- **Types**: `DraftOption`, `DraftRiskFlag`, `DisplayMessage`, `ContactFormData`
- **Constants**: `PLATFORM_CONFIG`, `ActionPlatform`, `getPlatformConfig`

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

Sync logic is modularized by platform (~2,900 LOC total, split into focused modules):

```
convex/
  sync.ts              Orchestrator (exports public API, ~600 LOC)
  sync/
    shared.ts          Common utilities (handle resolution, contact creation)
    imessage.ts        iMessage and macOS Contacts sync
    gmail.ts           Gmail emails and Google Contacts sync
    slack.ts           Slack messages sync
    linkedin.ts        LinkedIn messages sync
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
| Actions queue | `packages/convex/convex/actions.ts`, `actionQueue.ts` |
| Shared utils/types | `packages/shared/src/` |
| Contact resolution | `packages/ai/src/contact-resolution/` |
| LLM tools | `packages/ai/src/tools/` |
| AI chat UI | `packages/ui/src/components/assistant/` |
| Unified inbox | `packages/ui/src/components/unified-inbox/` |
| Action cards | `packages/ui/src/components/action-queue/` |
| Gmail/Slack | `packages/integrations/src/nango/` |
| iMessage sync | `apps/electron/src/main/sync/` |
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

Swift contacts CLI: `apps/electron/swift/`
Build Swift: `cd apps/electron/swift && swift build -c release`

## Common Issues

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Convex types missing | Run `cd packages/convex && pnpm dev` once |
| Swift build fails | Requires macOS 15+ and Swift 6.0+ |


## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.