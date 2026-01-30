# Convex Setup - Manual Steps Required

Task 1.6 requires interactive setup that must be completed manually.

## Steps to Complete

1. **Login to Convex** (one-time per machine):
   ```bash
   cd packages/convex
   npx convex login
   ```
   This will open a browser to authenticate with Convex.

2. **Initialize the project**:
   ```bash
   pnpm dev
   ```

   The CLI will prompt:
   - **"Would you like to create a new project?"** → Yes
   - **Project name** → Enter "cued" (or your preferred name)
   - **Team** → Select your team or create a new one

   This will:
   - Generate `convex/_generated/` directory with TypeScript types
   - Create `convex.config.js` or update `convex.json`
   - Start the Convex dev server
   - Open the Convex dashboard in your browser

3. **After initialization completes**, Convex will create:
   - `convex/_generated/` directory with TypeScript types
   - `.env.local` file with your deployment URL (auto-generated, gitignored)

   The `.env.local` will look like:
   ```
   CONVEX_DEPLOYMENT=dev:your-project-name-1234
   ```

4. **Verify Setup**:
   - Check that `convex/_generated/` directory exists
   - Check that `.env.local` exists with `CONVEX_DEPLOYMENT`
   - Visit the Convex dashboard (should auto-open at https://dashboard.convex.dev)
   - Confirm your project appears in the dashboard
   - The dashboard should show the empty schema

## Why This Can't Be Automated

The Convex CLI requires:
- Interactive browser authentication
- User selection of team/organization
- Project creation confirmation

These steps cannot be scripted in a non-interactive environment.

## Connecting apps/web to Convex

After initializing packages/convex, you need to provide credentials to apps/web:

1. **Copy the deployment URL** from `packages/convex/.env.local`

2. **Create `apps/web/.env.local`**:
   ```bash
   # Convex
   NEXT_PUBLIC_CONVEX_URL=https://your-project-name-1234.convex.cloud
   ```

   Note: For Next.js public environment variables, use `NEXT_PUBLIC_` prefix.

3. **Get the deployment URL** from the Convex dashboard:
   - Visit https://dashboard.convex.dev
   - Select your project
   - Go to Settings → URL & Deploy Key
   - Copy the "Deployment URL" (looks like `https://xyz.convex.cloud`)

## Verifying Credentials Work

### From packages/convex:
```bash
cd packages/convex
pnpm dev
```

If credentials work, you'll see:
- `✓ Connected to Convex`
- `✓ Watching for file changes...`
- No authentication errors

### From apps/web (after setup):
```bash
cd apps/web
pnpm dev
```

Add a test query in `apps/web/app/page.tsx`:
```typescript
import { useQuery } from "convex/react";

// This will error gracefully if schema is empty, but proves connection works
const data = useQuery(api.someFunction);
```

If you see connection errors, check:
1. `NEXT_PUBLIC_CONVEX_URL` is set in `apps/web/.env.local`
2. The URL matches your deployment URL from the dashboard
3. The URL is publicly accessible (dev deployments are public by default)

## Credential Storage

| Location | File | Variable | Purpose |
|----------|------|----------|---------|
| `packages/convex/` | `.env.local` | `CONVEX_DEPLOYMENT` | CLI authentication for `convex dev` |
| `apps/web/` | `.env.local` | `NEXT_PUBLIC_CONVEX_URL` | Client-side Convex connection |

Both `.env.local` files are gitignored and should never be committed.

## Next Steps

After completing this setup, the following tasks can proceed:
- Task 1.7: Define users table schema
- Task 1.8: Define integrations table schema
- Task 1.9: Define contacts and contactHandles tables
- Task 1.10: Define conversations table
- Task 1.11: Define messages table with search index
- Task 1.12: Define actions table
