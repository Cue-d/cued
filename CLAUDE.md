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
./afk-ralph.sh prds/slack-native-integration-prd.json 10  # 10 iterations
```

Both use the same prompt pattern - ONE Claude session handles multiple tasks.

### When to Use What

| User says | Action |
|-----------|--------|
| "work on PRM-123" | `pnpm prd start PRM-123` |
| "start PRM-123" | `pnpm prd start PRM-123` |
| "create PRD for PRM-123" | `pnpm prd start PRM-123` |
| "implement PRM-123" | `pnpm prd start PRM-123 --run` |
| "continue PRM-123" | `pnpm prd run prds/prm-123-prd.json` |
| "sync progress" | `pnpm prd sync prds/prm-123-prd.json` |

### After PR Creation

**MUST** link PR to Linear:
```bash
cd scripts && pnpm prd link-pr PRM-123 <pr-url>
```

### Direct Linear MCP Commands

For manual operations:
- `mcp__linear__list_issues` - List issues
- `mcp__linear__get_issue` - Get details
- `mcp__linear__update_issue` - Update status
- `mcp__linear__create_comment` - Add comments

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.