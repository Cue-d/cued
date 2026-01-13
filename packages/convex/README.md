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
  schema.ts      # Database schema definitions
  _generated/    # Auto-generated TypeScript types (gitignored)
```

## Next Steps

After initialization (task 1.6), complete:
- Task 1.7: Define users table schema
- Task 1.8: Define integrations table schema
- Task 1.9: Define contacts and contactHandles tables
- Task 1.10: Define conversations table
- Task 1.11: Define messages table with search index
- Task 1.12: Define actions table
