# @prm/convex

Convex backend package for PRM.

## Setup

1. Login to Convex (required once per machine):
   ```bash
   npx convex login
   ```

2. Initialize the project:
   ```bash
   pnpm dev
   ```

   This will:
   - Prompt you to create/select a Convex project
   - Generate `_generated/` directory with TypeScript types
   - Start the Convex dev server

3. The Convex dashboard will open at https://dashboard.convex.dev

## Development

```bash
pnpm dev         # Start Convex dev server
pnpm build       # Deploy to production
pnpm typecheck   # Run TypeScript type checking
```

## Project Structure

```
convex/
  schema.ts          # Database schema (users, contacts, messages, actions, etc.)
  sync.ts            # Data synchronization logic
  actions.ts         # Action management
  messages.ts        # Message operations
  contacts.ts        # Contact management
  search.ts          # Search functionality
  crons.ts           # Scheduled jobs
  _generated/        # Auto-generated TypeScript types (gitignored)
```
