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
   - **Project name** → Enter "prm" (or your preferred name)
   - **Team** → Select your team or create a new one

   This will:
   - Generate `convex/_generated/` directory with TypeScript types
   - Create `convex.config.js` or update `convex.json`
   - Start the Convex dev server
   - Open the Convex dashboard in your browser

3. **Verify Setup**:
   - Check that `convex/_generated/` directory exists
   - Visit the Convex dashboard (should auto-open at https://dashboard.convex.dev)
   - Confirm your project appears in the dashboard
   - The dashboard should show the empty schema

4. **Update prd.json**:
   Once verified, set `"passes": true` for task 1.6.

## Why This Can't Be Automated

The Convex CLI requires:
- Interactive browser authentication
- User selection of team/organization
- Project creation confirmation

These steps cannot be scripted in a non-interactive environment.

## Next Steps

After completing this setup, the following tasks can proceed:
- Task 1.7: Define users table schema
- Task 1.8: Define integrations table schema
- Task 1.9: Define contacts and contactHandles tables
- Task 1.10: Define conversations table
- Task 1.11: Define messages table with search index
- Task 1.12: Define actions table
