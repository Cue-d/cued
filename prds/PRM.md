# PRM Cloud Refactor Plan

## Overview

Refactor PRM from a local-first macOS Electron+FastAPI app to a cloud-based multi-platform personal relationship manager.

**Current Stack:** Electron + FastAPI (Python) + SQLite
**Target Stack:** Turborepo + Next.js + Convex + WorkOS + Pipedream + Mem0

**V1 Platforms:** iMessage (local sync), Gmail, Slack

---

## 1. Turborepo Structure

```
prm/
├── apps/
│   ├── web/                      # Next.js (marketing + app + API)
│   │   ├── app/
│   │   │   ├── (marketing)/      # Public pages
│   │   │   ├── (app)/            # Authenticated app (inbox, actions, assistant, contacts)
│   │   │   └── api/              # API routes (auth, assistant, pipedream webhooks, sync)
│   │   └── convex/               # Convex functions
│   │
│   └── electron/                 # macOS sync app (minimal)
│       └── src/main/sync/        # chat.db sync, contacts, uploader
│
├── packages/
│   ├── ui/                       # Shared React components (action cards, inbox, primitives)
│   ├── convex/                   # Shared schema & functions
│   ├── ai/                       # AI tools (search, contacts, actions, memory)
│   ├── integrations/             # Pipedream Gmail/Slack utilities
│   └── shared/                   # Phone normalization, date utils, types
```

---

## 2. Convex Schema (Key Tables)

| Table            | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `users`          | WorkOS auth, plan info                                            |
| `integrations`   | Connected platforms per user (pipedreamAccountId, syncState)      |
| `contacts`       | Cross-platform identity (displayName, importance, handles)        |
| `contactHandles` | Phone/email/slack_id → contactId mapping                          |
| `conversations`  | Unified threads (platform, type, participants, lastMessage)       |
| `messages`       | Message content, platform metadata, sender (full-text searchable) |
| `actions`        | Action queue (respond, follow_up, send_message, status)           |

**Note:** No `mem0References` table needed - use Convex `userId` and `contactId` directly as Mem0 identifiers.

---

## 3. Sync Architecture

### iMessage (Electron → Convex)

1. Electron reads chat.db (read-only, incremental via ROWID cursor)
2. Resolves contact names from Contacts.app
3. POSTs batches to `/api/sync/imessage`
4. Convex mutation upserts conversations/messages

### Gmail/Slack (Pipedream → Convex)

1. User connects via Pipedream Connect OAuth
2. **Real-time:** Pipedream webhooks POST new messages to `/api/pipedream/[platform]/webhook`
3. **Historical:** Background job fetches via Pipedream proxy API
4. Convex mutation upserts with platform-specific metadata

---

## 4. AI Assistant (Port from ai-message-assistant branch)

**Tools to implement:**

- `search_messages` - Convex full-text + vector search across platforms
- `search_contacts` - Convex query with name/company/notes
- `create_action` - Convex mutation to queue for user review
- `search_memories` - Mem0 API with person_id filtering
- `get_conversations` / `get_messages` - Convex queries

**API Route:** `/api/chat`

- Uses Vercel AI SDK with OpenAI (ZDR-ready)
- SSE streaming to frontend
- Tools executed with user context

**What to port:**

- Tool definitions from `backend/services/assistant/tools.py`
- Mem0 prompts from `backend/services/memory/mem0_service.py`
- Assistant UI from `frontend/src/renderer/src/components/Assistant/`

---

## 5. Pipedream Integration

```typescript
// OAuth connection
const { connect } = usePipedreamConnect();
await connect("gmail", { oauthAppId: GMAIL_APP_ID });

// Send message via proxy
await pd.proxy.post(accountId, "gmail", "/users/me/messages/send", {
  body: { raw },
});
await pd.proxy.post(accountId, "slack", "/chat.postMessage", {
  body: { channel, text },
});
```

---

## 6. Security

**Data Protection (v1):**

- Convex provides encryption at rest (AES-256)
- TLS 1.3 for all data in transit
- No custom E2E encryption for v1 (simplifies search and reduces complexity)
- Can add E2E encryption in future for enterprise customers who require it

**Auth:**

- WorkOS AuthKit with enterprise SSO support (SAML, OIDC)
- Device auth flow for Electron app
- Pipedream stores OAuth tokens (never in our database)

---

## 7. Migration Phases

### Phase 1: Foundation (HUMAN-IN-THE-LOOP)

> Run `./ralph-once.sh` and review each commit carefully

- [ ] 1.1 Initialize Turborepo: `npx create-turbo@latest`
- [ ] 1.2 Create `apps/web` as Next.js 14 app with App Router
- [ ] 1.3 Create `apps/electron` scaffold (minimal, sync-only)
- [ ] 1.4 Create `packages/ui` with shadcn/ui setup
- [ ] 1.5 Create `packages/shared` with phone normalization utils
- [ ] 1.6 Create `packages/convex` and initialize Convex project
- [ ] 1.7 Define Convex schema: `users` table
- [ ] 1.8 Define Convex schema: `integrations` table
- [ ] 1.9 Define Convex schema: `contacts` and `contactHandles` tables
- [ ] 1.10 Define Convex schema: `conversations` table
- [ ] 1.11 Define Convex schema: `messages` table with search index
- [ ] 1.12 Define Convex schema: `actions` table
- [ ] 1.13 Install WorkOS AuthKit: `pnpm add @workos-inc/authkit-nextjs`
- [ ] 1.14 Create WorkOS auth routes (`/api/auth/[...workos]`)
- [ ] 1.15 Create auth middleware for protected routes
- [ ] 1.16 Test auth flow end-to-end (sign up, sign in, sign out)
- [ ] 1.17 Create basic marketing page layout
- [ ] 1.18 Create authenticated app shell with sidebar

### Phase 2: iMessage Sync (HUMAN-IN-THE-LOOP)

> Still supervise closely - sync is tricky

- [ ] 2.1 Create `packages/integrations` with iMessage types
- [ ] 2.2 Port `chat_db.py` logic to TypeScript in Electron
- [ ] 2.3 Port contact resolver to TypeScript in Electron
- [ ] 2.4 Create Electron auth flow (WorkOS device auth)
- [ ] 2.5 Create `/api/sync/imessage` POST endpoint
- [ ] 2.6 Create Convex mutation `syncMessages` for batch upsert
- [ ] 2.7 Create Convex mutation `syncContacts` for contact upsert
- [ ] 2.8 Implement incremental sync with ROWID cursor
- [ ] 2.9 Port inbox UI to `packages/ui/unified-inbox`
- [ ] 2.10 Create Convex query `getInbox` with pagination
- [ ] 2.11 Create conversation detail view
- [ ] 2.12 Test full sync cycle: Electron → API → Convex → UI

### Phase 3: AI Assistant (AFK-READY)

> Can run `./afk-ralph.sh 10` for this phase

- [ ] 3.1 Create `packages/ai` with tool type definitions
- [ ] 3.2 Port `search_messages` tool to TypeScript
- [ ] 3.3 Port `search_contacts` tool to TypeScript
- [ ] 3.4 Port `create_action` tool to TypeScript
- [ ] 3.5 Port `get_conversations` tool to TypeScript
- [ ] 3.6 Port `search_memories` tool (Mem0 API client)
- [ ] 3.7 Create `/api/chat` streaming route
- [ ] 3.8 Set up Vercel AI SDK with OpenAI
- [ ] 3.9 Port system prompt from `backend/services/assistant/llm.py`
- [ ] 3.10 Port `AssistantView` component to packages/ui
- [ ] 3.11 Port `ChatMessage` component with artifacts
- [ ] 3.12 Port `SuggestedPrompts` component
- [ ] 3.13 Connect Mem0 service with custom prompts
- [ ] 3.14 Test assistant end-to-end

### Phase 4: Gmail (AFK-READY)

- [ ] 4.1 Set up Pipedream project and get API keys
- [ ] 4.2 Create Pipedream Gmail OAuth app
- [ ] 4.3 Create `/settings/integrations` page
- [ ] 4.4 Implement Gmail connect button with Pipedream SDK
- [ ] 4.5 Create Convex mutation to store integration
- [ ] 4.6 Create `/api/pipedream/gmail/webhook` receiver
- [ ] 4.7 Create Convex mutation `syncGmailMessage`
- [ ] 4.8 Create historical sync worker (Convex scheduled function)
- [ ] 4.9 Create `sendGmailMessage` in packages/integrations
- [ ] 4.10 Wire Gmail send to action queue completion

### Phase 5: Slack (AFK-READY)

- [ ] 5.1 Create Pipedream Slack OAuth app
- [ ] 5.2 Implement Slack connect button
- [ ] 5.3 Create `/api/pipedream/slack/webhook` receiver
- [ ] 5.4 Create Convex mutation `syncSlackMessage`
- [ ] 5.5 Handle Slack DMs vs channels
- [ ] 5.6 Create `sendSlackMessage` in packages/integrations
- [ ] 5.7 Wire Slack send to action queue completion

### Phase 6: Polish (AFK-READY)

- [ ] 6.1 Create contact merge UI for cross-platform resolution
- [ ] 6.2 Add platform filter to unified inbox
- [ ] 6.3 Add platform badges to conversation list
- [ ] 6.4 Create action routing (pick platform to send from)
- [ ] 6.5 Add keyboard shortcuts (Cmd+K, etc.)
- [ ] 6.6 Write integration tests for sync flows
- [ ] 6.7 Write E2E tests for critical paths
- [ ] 6.8 Production deployment checklist

---

## 8. What to Keep vs Rewrite

### Keep (adapt to TypeScript/Convex):

- `backend/services/assistant/tools.py` - Tool logic
- `backend/services/memory/mem0_service.py` - Mem0 config and prompts
- `frontend/src/renderer/src/components/Assistant/` - UI components
- `frontend/src/renderer/src/components/ActionQueue/CardStack.tsx` - Swipe UI

### Rewrite:

- Database layer → Convex schema + functions
- API routes → Next.js API routes
- Auth → WorkOS AuthKit
- Search → Convex search indexes
- Background jobs → Convex scheduled functions

### Discard:

- `chat_db.py` (stays in Electron only)
- `prm_db.py` (replaced by Convex)
- Swift LLM CLI (using OpenAI ZDR)
- APScheduler (using Convex crons)

---

## 9. Critical Files to Reference

| File                                      | Purpose                         |
| ----------------------------------------- | ------------------------------- |
| `backend/services/assistant/tools.py`     | AI tool implementations to port |
| `backend/services/memory/mem0_service.py` | Mem0 prompts and graph config   |
| `backend/db/prm_db.py`                    | Current schema patterns         |
| `frontend/.../ActionQueue/CardStack.tsx`  | Swipe UI to port                |
| `backend/routers/actions.py`              | Action queue API patterns       |

---

## 10. Verification Plan

1. **Sync Test:** Connect iMessage on Mac, verify messages appear in web inbox
2. **Gmail Test:** OAuth connect, send test email, verify received
3. **Slack Test:** OAuth connect, send DM, verify received
4. **Assistant Test:** Ask "Who have I talked to this week?" - should search across platforms
5. **Action Test:** Create follow-up action, swipe to send, verify delivered
6. **Memory Test:** Add memory about contact, verify assistant can recall it
