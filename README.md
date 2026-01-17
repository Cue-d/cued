# PRM - Personal Relationship Manager

A cloud-based personal CRM with multi-platform messaging (iMessage, Gmail, Slack) and AI-powered action suggestions.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 22+ | `node --version` |
| pnpm | 9+ | `pnpm --version` |

**For Electron app (macOS only):**
- Swift 6.0+ (`swift --version`)
- Full Disk Access and Contacts permissions in System Settings

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development servers
pnpm dev
```

Web app opens at http://localhost:3000

## Project Structure

```
apps/
  web/           Next.js web application
  electron/      macOS desktop app (iMessage sync)

packages/
  ui/            Shared React components
  shared/        Shared utilities
  convex/        Convex backend
  ai/            AI/LLM integration
  integrations/  Platform integrations
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start all apps in dev mode |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint all packages |
| `pnpm typecheck` | Type check all packages |
| `pnpm test` | Run all tests |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Error accessing messages database" | Grant Full Disk Access to your terminal |
| "Contacts access denied" | Grant Contacts access in System Settings |
| Convex types missing | Run `cd packages/convex && pnpm dev` |

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed development documentation.
