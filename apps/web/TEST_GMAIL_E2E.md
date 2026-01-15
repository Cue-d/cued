# Gmail Integration E2E Test (Task 4.14)

## Prerequisites
- Dev server running: `cd apps/web && pnpm dev`
- Convex deployed: `cd packages/convex && npx convex dev`
- Nango integrations deployed: `cd nango-integrations && npx nango deploy dev`

## Test Steps

### 1. Connect Gmail Account
1. Navigate to http://localhost:3000/settings/integrations
2. Click "Connect" on the Gmail card
3. Complete OAuth flow in popup
4. Verify "Connected" status appears

**Verification:**
```bash
npx convex run 'integrations:debugGmailStats' '{}'
```
Expected: `hasNangoConnection: true`, `isConnected: true`

### 2. Verify Nango Sync Triggers
1. Check Nango Dashboard > Connections > [your connection]
2. Verify "emails" and "contacts" syncs show "Running" or "Success"
3. If sync shows "Error", check sync logs for details

**Manual Sync Trigger (if webhook not working):**
```bash
# Get your connection ID from Nango Dashboard
# Get your workosUserId from WorkOS Dashboard or Convex users table

curl -X POST http://localhost:3000/api/nango/pull-gmail \
  -H "Content-Type: application/json" \
  -d '{"connectionId": "YOUR_CONNECTION_ID", "workosUserId": "YOUR_WORKOS_USER_ID"}'

curl -X POST http://localhost:3000/api/nango/pull-google-contacts \
  -H "Content-Type: application/json" \
  -d '{"connectionId": "YOUR_CONNECTION_ID", "workosUserId": "YOUR_WORKOS_USER_ID"}'
```

### 3. Verify Emails in Convex
```bash
npx convex run 'integrations:debugGmailStats' '{}'
```
Expected:
- `stats.conversationSample > 0`
- `stats.messageSample > 0`
- `sampleConversations` shows email subjects

### 4. Verify Inbox UI
1. Navigate to http://localhost:3000/inbox
2. Verify Gmail conversations appear in list (look for email-style subjects)
3. Click on a Gmail conversation
4. Verify email content displays correctly

### 5. Send Test Reply (Optional)
1. In inbox, select a Gmail conversation
2. Type a reply message
3. Click Send
4. Check Gmail sent folder for the message

**API Test:**
```bash
curl -X POST http://localhost:3000/api/gmail/send \
  -H "Content-Type: application/json" \
  -d '{
    "workosUserId": "YOUR_WORKOS_USER_ID",
    "conversationId": "CONVERSATION_ID",
    "to": "recipient@example.com",
    "subject": "Re: Test",
    "body": "Test reply from PRM"
  }'
```

### 6. Verify Google Contacts Sync
```bash
npx convex run 'integrations:debugGmailStats' '{}'
```
Check `totalContactsSynced` in integration stats.

## Troubleshooting

### No emails syncing
1. Check Nango Dashboard for sync errors
2. Verify webhook URL is configured: `https://your-app.com/api/nango/webhook`
3. Check app server logs for webhook events
4. Manually trigger pull (see step 2)

### OAuth fails
1. Verify Google OAuth credentials in Nango Dashboard
2. Check redirect URIs match your app URL
3. Ensure required scopes are enabled

### Messages not appearing in UI
1. Verify emails exist in Convex: `npx convex run 'integrations:debugGmailStats' '{}'`
2. Check browser console for errors
3. Verify auth token is valid

## Current Status

Run this to check current Gmail integration status:
```bash
npx convex run 'integrations:debugGmailStats' '{}'
```

Output interpretation:
- `integrations[].hasNangoConnection: true` = OAuth completed
- `integrations[].isConnected: true` = Integration active
- `integrations[].lastSyncAt` = Timestamp of last successful pull
- `stats.conversationSample` = Gmail threads found
- `stats.messageSample` = Gmail messages found
