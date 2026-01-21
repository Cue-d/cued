# PRD: Native Slack Integration (Session-Based)

## Overview

Replace Nango-based Slack integration with native implementation using browser session tokens (xoxc- + d cookie). Matches iMessage/LinkedIn stealth pattern - no workspace app installation, no visibility to other users.

## Architecture

```
apps/electron/ (Mac is the sync hub)
  ├── iMessage    ← local chat.db
  ├── LinkedIn    ← local browser context (cookies)
  └── Slack       ← local keychain storage (xoxc + d cookie)
         │
         ├── SlackClient (fetch-based)
         │     ├── Auth: Bearer xoxc- + Cookie: d=xoxd-
         │     ├── REST: conversations.*, chat.*, users.*
         │     └── RTM: WebSocket for real-time
         │
         └── Sync to Convex (messages, contacts, conversations only)
                    │
packages/convex/convex/sync/slack.ts  ◄───┘
  └── Same pattern as linkedin.ts
```

**Token Storage: LOCAL ONLY (like LinkedIn)**
- Tokens stored in Electron's secure storage (macOS Keychain)
- Never sent to cloud database
- More secure - session tokens are essentially passwords
- Requires Electron running for sync (same as iMessage/LinkedIn)

## Authentication (mautrix/slack Pattern)

### Token Types
- `xoxc-*` - User session API token (per-workspace)
- `xoxd-*` - Browser session cookie (shared across workspaces)

### Extraction Method (Electron Webview)
```javascript
// Extract from browser after login
const token = JSON.parse(localStorage.localConfig_v2)
  .teams[document.location.pathname.match(/^\/client\/([A-Z0-9]+)/)[1]].token;
const cookie = document.cookie.match(/d=([^;]+)/)?.[1];
```

### API Authentication
```typescript
// Every request needs both
headers: {
  'Authorization': `Bearer ${xoxcToken}`,
  'Cookie': `d=${xoxdCookie}`
}
```

## Implementation Tasks

### Phase 1: Electron Login Flow + Local Token Storage

**1.1 Create Slack Login Webview** (`apps/electron/src/main/auth/slack-login.ts`)
- Open webview to `https://{workspace}.slack.com`
- Wait for successful login (detect localStorage token)
- Extract xoxc- token + d cookie
- Store in Electron secure storage (macOS Keychain)

**1.2 Token Extraction Script**
```typescript
const extractionScript = `
  (function() {
    try {
      const localConfig = JSON.parse(localStorage.getItem('localConfig_v2'));
      const teamId = Object.keys(localConfig.teams)[0];
      const token = localConfig.teams[teamId].token;
      const cookie = document.cookie.match(/d=([^;]+)/)?.[1];
      return { token, cookie, teamId };
    } catch (e) {
      return { error: e.message };
    }
  })()
`;
```

**1.3 Local Credential Storage** (`apps/electron/src/main/auth/slack-credentials.ts`)

Use Electron's safeStorage API (encrypts with OS keychain):
```typescript
import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'slack-credentials' })

export interface SlackStoredCredentials {
  token: string      // xoxc-*
  cookie: string     // xoxd-*
  teamId: string
  userId: string
  teamName: string
}

export function saveSlackCredentials(creds: SlackStoredCredentials): void {
  const encrypted = safeStorage.encryptString(JSON.stringify(creds))
  store.set('credentials', encrypted.toString('base64'))
}

export function getSlackCredentials(): SlackStoredCredentials | null {
  const encrypted = store.get('credentials') as string | undefined
  if (!encrypted) return null
  const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  return JSON.parse(decrypted)
}

export function clearSlackCredentials(): void {
  store.delete('credentials')
}
```

**1.4 Update Convex Integration Record** (metadata only, no tokens)
```typescript
// integrations table stores connection status, NOT credentials
await convex.mutation(api.integrations.updateSlackStatus, {
  isConnected: true,
  teamId: creds.teamId,
  teamName: creds.teamName,
  userId: creds.userId, // For isFromMe detection
})
```

### Phase 2: Native Slack Client

**2.1 Create Client** (`packages/integrations/src/slack/client.ts`)

Core class matching mautrix/slack:
```typescript
export class SlackClient {
  private token: string;    // xoxc-*
  private cookie: string;   // xoxd-*
  private teamId: string;

  // Validate credentials
  async testAuth(): Promise<AuthTestResponse>

  // Get user's conversations (DMs, channels user is in)
  async listConversations(cursor?: string): Promise<ConversationsListResponse>

  // Get message history
  async getHistory(channelId: string, opts?: HistoryOptions): Promise<HistoryResponse>

  // Get thread replies
  async getReplies(channelId: string, threadTs: string): Promise<RepliesResponse>

  // Send message
  async postMessage(channelId: string, text: string, threadTs?: string): Promise<PostMessageResponse>

  // Get user profile (for contact enrichment)
  async getUserInfo(userId: string): Promise<UserInfoResponse>

  // Real-time connection
  async connectRTM(): Promise<RTMConnection>
}
```

**2.2 API Methods to Implement**

| Method | Slack API | Purpose |
|--------|-----------|---------|
| `testAuth()` | `auth.test` | Validate token, get user/team info |
| `listConversations()` | `users.conversations` | Get user's DMs, channels, groups |
| `getHistory()` | `conversations.history` | Fetch messages (with cursor pagination) |
| `getReplies()` | `conversations.replies` | Fetch thread messages |
| `postMessage()` | `chat.postMessage` | Send messages |
| `getUserInfo()` | `users.info` | Get user profile for contact enrichment |
| `getConversationInfo()` | `conversations.info` | Get channel metadata |

**2.3 RTM (Real-Time Messaging)** (`packages/integrations/src/slack/rtm.ts`)

For real-time message sync (like mautrix/slack):
```typescript
export class SlackRTM {
  private ws: WebSocket;
  private token: string;
  private cookie: string;

  // Connect to RTM
  async connect(): Promise<void>

  // Event handlers
  onMessage(handler: (msg: RTMMessage) => void): void
  onReaction(handler: (reaction: RTMReaction) => void): void
  onPresence(handler: (presence: RTMPresence) => void): void

  // Reconnection logic
  private reconnect(): Promise<void>
}
```

RTM WebSocket URL obtained via `rtm.connect` API call.

### Phase 3: Convex Sync Logic

**3.1 Update Validators** (`packages/convex/convex/sync/slack.ts`)

Already good, minor additions:
```typescript
// Add conversation sync input (like LinkedIn)
export const slackConversationInput = v.object({
  id: v.string(),           // Channel ID
  type: v.union(v.literal("im"), v.literal("channel"), v.literal("group"), v.literal("mpim")),
  name: v.optional(v.string()),
  isArchived: v.boolean(),
  isMember: v.boolean(),
  lastRead: v.optional(v.string()),  // Timestamp
  unreadCount: v.optional(v.number()),
});
```

**3.2 Add Conversation Sync** (like LinkedIn)
```typescript
export async function syncSlackConversationsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversations: SlackConversationInput[]
)
```

**3.3 Update Message Sync for isFromMe**
- Store user's Slack ID in integration credentials
- Compare message sender to detect isFromMe

### Phase 4: Message Sending

**4.1 Update Message Queue Processor** (`apps/electron/src/main/queue/message-queue-processor.ts`)

Add Slack handler using native client:
```typescript
case "slack":
  const slackClient = new SlackClient(credentials);
  await slackClient.postMessage(
    item.chatIdentifier,
    item.text,
    item.threadTs
  );
  break;
```

**4.2 Update Web API Route** (`apps/web/app/api/slack/send/route.ts`)

Replace Nango action with direct API call via server-side SlackClient.

### Phase 5: Contact Creation (Conversation-Based)

Contacts created organically from conversations (like LinkedIn/iMessage) - NOT all workspace members.

**5.1 Contact Creation Flow**
- When syncing conversations: create contacts from DM participants
- When syncing messages: create contacts from message senders
- Only people user actually interacts with become contacts

**5.2 Enrich Contacts** (`packages/integrations/src/slack/client.ts`)
```typescript
// Fetch user profile for contact enrichment
async getUserInfo(userId: string): Promise<UserInfoResponse>
```

For each conversation participant:
- Create contact with `displayName` from Slack profile (real_name or display_name)
- Create contactHandle with `handleType: "slack_id"`, `handle: slackUserId`
- If profile has email: check for existing contact match, link or create additional handle

**5.3 Update getOrCreateSlackContact** (existing in `sync/slack.ts`)
- Already creates contacts on-demand from message senders
- Add profile enrichment: fetch real_name, email from `users.info` API
- Match existing contacts by email if available

### Phase 6: Remove Nango Slack

**Files to Delete:**
- `packages/integrations/src/nango/slack.ts`
- `nango-integrations/slack/` (entire directory)
- `apps/web/app/api/nango/pull-slack/route.ts`
- `apps/web/__tests__/api/pull-slack.test.ts`
- `apps/web/SLACK_SETUP.md`

**Files to Update:**
- `packages/integrations/src/nango/index.ts` - Remove Slack exports
- `apps/web/(app)/settings/integrations/page.tsx` - New OAuth flow
- `packages/convex/convex/integrations.ts` - Remove Nango connection references

## File Structure (New)

```
packages/integrations/src/slack/
  ├── index.ts           # Exports
  ├── types.ts           # Type definitions (✅ DONE)
  ├── constants.ts       # API URLs, headers (✅ DONE)
  ├── request.ts         # Request builder (✅ DONE)
  ├── client.ts          # SlackClient class (✅ DONE)
  └── __tests__/
      └── client.test.ts

apps/electron/src/main/
  ├── auth/
  │   ├── slack-login.ts        # Webview login flow
  │   └── slack-credentials.ts  # Local keychain storage
  └── sync/
      └── slack-sync.ts         # Sync orchestrator (like linkedin-sync.ts)
```

## API Reference (Slack Web API)

### auth.test
```
POST https://slack.com/api/auth.test
Headers: Authorization: Bearer xoxc-*, Cookie: d=xoxd-*
Response: { ok, user_id, team_id, team, user }
```

### users.info
```
POST https://slack.com/api/users.info
Params: user (Slack user ID)
Response: { ok, user: { id, name, real_name, profile: { email, display_name, image_* } } }
```

### users.conversations
```
POST https://slack.com/api/users.conversations
Params: cursor, limit, types (im,mpim,private_channel,public_channel)
Response: { ok, channels[], response_metadata.next_cursor }
```

### conversations.history
```
POST https://slack.com/api/conversations.history
Params: channel, cursor, limit (default 100, max 1000), oldest, latest
Response: { ok, messages[], has_more, response_metadata.next_cursor }
```

### conversations.replies
```
POST https://slack.com/api/conversations.replies
Params: channel, ts (thread parent), cursor, limit
Response: { ok, messages[], has_more }
```

### chat.postMessage
```
POST https://slack.com/api/chat.postMessage
Params: channel, text, thread_ts (optional)
Response: { ok, ts, channel, message }
```

### rtm.connect
```
POST https://slack.com/api/rtm.connect
Response: { ok, url (WebSocket URL), self, team }
```

## Dependencies

```json
{
  // No @slack/web-api - using raw fetch for cookie auth
  // No @slack/rtm-api - custom WebSocket implementation
}
```

Using raw fetch because @slack/web-api doesn't support cookie authentication.

## Security Considerations

1. **Token Storage**: LOCAL ONLY - encrypted in macOS Keychain via Electron safeStorage
   - Tokens never leave the device
   - Same pattern as LinkedIn browser context storage
   - More secure than cloud storage for session tokens
2. **Token Refresh**: Monitor for auth failures, prompt re-login via Electron webview
3. **No App Installation**: Workspace admins cannot see this integration
4. **User Privacy**: Only accesses user's own conversations
5. **Convex stores metadata only**: teamId, teamName, userId, isConnected - no secrets

## Testing Plan

1. **Unit Tests**
   - SlackClient methods with mocked responses
   - Token extraction script
   - Message parsing

2. **Integration Tests**
   - Full login flow in Electron
   - Message sync end-to-end
   - Send message flow

3. **Manual Testing**
   - Login to multiple workspaces
   - Sync DMs, channels, threads
   - Send/receive messages
   - Verify contacts created from conversation participants only (not all workspace members)

## Rollout Plan

1. Feature flag: `SLACK_NATIVE_ENABLED`
2. Gradual migration from Nango
3. Remove Nango code after validation

## Unresolved Questions

1. **Multi-workspace**: Should we support multiple Slack workspaces per user?
   - If yes: store array of credentials keyed by teamId
2. **Token Expiry**: How often do xoxc/xoxd tokens expire? Need refresh flow?
   - Likely long-lived but can be invalidated by Slack
   - Monitor for auth errors, prompt re-login
3. **Enterprise Grid**: Do we need enterprise_api_token support?
4. **Rate Limits**: What are the rate limits for session-based tokens?

## Resolved Decisions

1. **Token Storage**: LOCAL ONLY (macOS Keychain) - matches LinkedIn pattern, more secure
2. **Contact Sync**: Conversation-based only - no bulk workspace member import
3. **Architecture**: Electron is sync hub (same as iMessage/LinkedIn)
