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
  electron/         macOS sync client (iMessage, Contacts)

packages/
  ui/               Shared React components (@prm/ui)
  shared/           Phone utils, types (@prm/shared)
  convex/           Database schema + functions (@prm/convex)
  ai/               LLM tools, Mem0 integration (@prm/ai)
  integrations/     iMessage, Nango adapters (@prm/integrations)
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
| Sync logic | `packages/convex/convex/sync.ts` |
| Actions queue | `packages/convex/convex/actions.ts`, `actionQueue.ts` |
| Contact resolution | `packages/ai/src/contact-resolution/` |
| LLM tools | `packages/ai/src/tools/` |
| AI chat UI | `packages/ui/src/components/ai-elements/` |
| Unified inbox | `packages/ui/src/components/unified-inbox/` |
| Action cards | `packages/ui/src/components/action-queue/` |
| Gmail/Slack | `packages/integrations/src/nango/` |
| iMessage sync | `apps/electron/src/main/sync/` |
| Swift contacts CLI | `apps/electron/swift/` |
| Web routes | `apps/web/app/(app)/`, `app/api/` |

## Behaviors

### DO

- Use `@/` path aliases for imports in apps
- Run `pnpm lint && pnpm typecheck` before commits
- Use `pnpm dlx shadcn@latest add [component] --yes` to add UI components
- Verify shadcn imports use `@/` aliases after adding

### DON'T

- Don't use `"use client"` in packages/ui (it's a shared library)
- Don't modify Convex `_generated/` files

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps/packages in dev mode |
| `pnpm build` | Build everything |
| `pnpm lint` | Lint all packages |
| `pnpm typecheck` | Type check all packages |
| `pnpm test` | Run all tests |

## Testing

```bash
pnpm test                    # All tests (Vitest)
cd apps/web && pnpm test:e2e # E2E tests (Playwright)
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
EOF