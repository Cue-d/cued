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
pnpm test        # Run tests in watch mode
pnpm test:once   # Run tests once
pnpm test:coverage  # Run tests with coverage report
```

## Testing

Tests use [convex-test](https://docs.convex.dev/testing/convex-test) with Vitest. This library provides a mock Convex backend implementation for fast, isolated unit testing.

### Test Structure

```
convex/
  __tests__/
    helpers.ts       # Test utilities and data factories
    actions.test.ts  # Tests for actions.ts
    contacts.test.ts # Tests for contacts.ts
    sync.test.ts     # Tests for sync.ts
```

### Writing Tests

```typescript
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { createTestUserData, createTestActionData } from "./helpers";

describe("actions", () => {
  it("creates action correctly", async () => {
    const t = convexTest(schema);

    const action = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", createTestUserData());
      const actionId = await ctx.db.insert("actions", createTestActionData(userId));
      return ctx.db.get(actionId);
    });

    expect(action?.status).toBe("pending");
  });
});
```

### Key Patterns

- **Direct DB access**: Use `t.run()` to directly read/write the database
- **Schema validation**: Pass `schema` to `convexTest()` for proper type checking
- **Test helpers**: Use factories from `helpers.ts` for consistent test data
- **Isolated tests**: Each test starts with a fresh, empty database

### Limitations

- Mock implementation may differ slightly from production
- No cron job support (trigger manually)
- Text/vector search is simplified

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
