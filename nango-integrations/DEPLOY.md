# Nango Integrations Deployment Guide

This guide covers deploying the Nango integrations (Gmail sync, Google Contacts sync, Gmail send action) to Nango's cloud.

## Quick Reference

```bash
cd nango-integrations

# Development
pnpm compile                    # Typecheck and compile
npx nango deploy dev            # Deploy to dev environment

# Production
npx nango deploy prod           # Deploy to production

# CI/CD (non-interactive)
npx nango deploy prod --auto-confirm --allow-destructive
```

## Prerequisites

1. **Nango account** at [app.nango.dev](https://app.nango.dev)
2. **Node.js 20+** installed
3. **Secret keys** from Nango Dashboard → Environment Settings

## Environment Setup

Create a `.env` file in the `nango-integrations/` directory:

```bash
# Required: Get from Nango Dashboard → Environment Settings
NANGO_SECRET_KEY_DEV=nango_dev_xxxx
NANGO_SECRET_KEY_PROD=nango_prod_xxxx

# Optional: For self-hosted Nango instances
# NANGO_HOSTPORT=http://localhost:3003
```

Toggle between dev/prod environments in the Nango dashboard left nav to get the correct keys.

## Project Structure

```
nango-integrations/
├── index.ts                    # Imports all syncs and actions
├── package.json                # Nango CLI dependency
├── tsconfig.json               # TypeScript config (managed by Nango)
├── .env                        # Secret keys (gitignored)
├── .nango/
│   └── schema.ts               # Auto-generated models
└── google/
    ├── types.ts                # Gmail/People API types
    ├── syncs/
    │   ├── emails.ts           # Gmail emails sync (5 min)
    │   └── contacts.ts         # Google Contacts sync (5 min)
    └── actions/
        └── send-email.ts       # Gmail send action
```

## Deployment Commands

### 1. Compile (Typecheck)

```bash
pnpm compile
# or
npx nango compile
```

This validates TypeScript types and catches errors before deployment.

### 2. Deploy to Development

```bash
npx nango deploy dev
```

- Uses `NANGO_SECRET_KEY_DEV`
- Prompts for confirmation before applying changes
- Shows diff of what will be deployed

### 3. Deploy to Production

```bash
npx nango deploy prod
```

- Uses `NANGO_SECRET_KEY_PROD`
- Prompts for confirmation
- Same integration code, different environment

### 4. Verify Deployment

1. Go to [Nango Dashboard](https://app.nango.dev)
2. Navigate to **Integrations** → **google**
3. Confirm syncs and actions are listed:
   - `emails` sync (5-minute frequency)
   - `contacts` sync (5-minute frequency)
   - `send-email` action

## CLI Flags

| Flag | Description |
|------|-------------|
| `--auto-confirm` | Skip confirmation prompts (for CI) |
| `--allow-destructive` | Allow removing syncs or renaming models |
| `--no-interactive` | Disable interactive mode entirely |

### Examples

```bash
# CI deployment (auto-confirm, allow destructive changes)
npx nango deploy prod --auto-confirm --allow-destructive

# Force non-interactive mode
npx nango deploy dev --no-interactive
```

## CI/CD Setup

### GitHub Actions

Create `.github/workflows/nango-deploy.yml`:

```yaml
name: Deploy Nango Integrations

on:
  push:
    branches: [main]
    paths:
      - 'nango-integrations/**'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: nango-integrations

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install

      - name: Compile
        run: npx nango compile

      - name: Deploy to Production
        run: npx nango deploy prod --auto-confirm --allow-destructive
        env:
          NANGO_SECRET_KEY_PROD: ${{ secrets.NANGO_SECRET_KEY_PROD }}
```

### Required Secrets

Add to GitHub repository secrets:

| Secret | Description |
|--------|-------------|
| `NANGO_SECRET_KEY_PROD` | Production secret key from Nango Dashboard |
| `NANGO_SECRET_KEY_DEV` | (Optional) Dev secret key for staging |

### Multi-Environment Workflow

```yaml
name: Deploy Nango Integrations

on:
  push:
    branches:
      - main
      - develop
    paths:
      - 'nango-integrations/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: nango-integrations

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm install

      - run: npx nango compile

      - name: Deploy to Dev
        if: github.ref == 'refs/heads/develop'
        run: npx nango deploy dev --auto-confirm --allow-destructive
        env:
          NANGO_SECRET_KEY_DEV: ${{ secrets.NANGO_SECRET_KEY_DEV }}

      - name: Deploy to Production
        if: github.ref == 'refs/heads/main'
        run: npx nango deploy prod --auto-confirm --allow-destructive
        env:
          NANGO_SECRET_KEY_PROD: ${{ secrets.NANGO_SECRET_KEY_PROD }}
```

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `NANGO_SECRET_KEY_DEV` | Dev environment secret key | For dev deploys |
| `NANGO_SECRET_KEY_PROD` | Prod environment secret key | For prod deploys |
| `NANGO_HOSTPORT` | Nango API URL (default: `https://api.nango.dev`) | For self-hosted |
| `NANGO_CLI_UPGRADE_MODE` | CLI upgrade behavior: `prompt`, `auto`, `ignore` | No |
| `NANGO_DEPLOY_AUTO_CONFIRM` | Auto-confirm deploys (same as `--auto-confirm`) | No |
| `CI` | When set, disables interactive mode automatically | No |

## Current Integrations

### Gmail Emails Sync (`google/syncs/emails.ts`)

- **Frequency**: Every 5 minutes
- **Sync type**: Incremental (cursor-based)
- **Backfill**: 1 year default (configurable via metadata)
- **Scope**: `gmail.readonly`
- **Endpoint**: `GET /emails`

### Google Contacts Sync (`google/syncs/contacts.ts`)

- **Frequency**: Every 5 minutes
- **Sync type**: Incremental (sync token-based)
- **Token expiry**: 7 days (auto-falls back to full sync)
- **Scope**: `contacts.readonly`
- **Endpoint**: `GET /contacts`

### Gmail Send Action (`google/actions/send-email.ts`)

- **Scope**: `gmail.send`
- **Endpoint**: `POST /google/emails`
- **Supports**: Threading (`threadId`, `inReplyTo`, `references`)

## Troubleshooting

### "Invalid secret key" Error

- Verify `.env` file exists in `nango-integrations/` directory
- Check key format: `nango_dev_xxxx` or `nango_prod_xxxx`
- Ensure you're using the correct key for the target environment

### "Sync token expired" (Google Contacts)

- Normal behavior: Google sync tokens expire after 7 days of inactivity
- The sync automatically falls back to full sync when this happens
- No action needed; the sync will continue normally

### Destructive Changes Blocked

When removing syncs or renaming models:

```bash
npx nango deploy prod --allow-destructive
```

### CI Deployment Hangs

- Ensure `--auto-confirm` flag is set
- The CI environment variable should be set (GitHub Actions sets this automatically)

### Compile Errors

```bash
# Check TypeScript errors
npx nango compile

# Common issues:
# - Missing types in google/types.ts
# - Import path errors (.js extension required for ESM)
# - Zod schema mismatches
```

## Local Development

For local testing with `nango dev`:

```bash
cd nango-integrations
npx nango dev
```

This starts a local development server that hot-reloads on changes.

## Related Documentation

- [NANGO_SETUP.md](../apps/web/NANGO_SETUP.md) - OAuth and integration setup guide
- [Nango CLI Reference](https://docs.nango.dev/reference/cli) - Full CLI documentation
- [Nango Custom Integrations](https://docs.nango.dev/customize/guides/setup) - Custom sync/action guide
