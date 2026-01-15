# Nango Integration Setup - Gmail

Task 4.2 requires manual configuration in the Nango dashboard and Google Cloud Console.

## Prerequisites

- Nango account created at https://app.nango.dev (task 4.1)
- NANGO_SECRET_KEY already added to `.env.local`

## Step 1: Add Google Mail Integration in Nango

1. Log in to [Nango Dashboard](https://app.nango.dev)
2. Navigate to **Integrations** tab
3. Click **Configure New Integration**
4. Search for and select **google-mail** (or "Google Mail" / "Gmail")
5. Note the **Callback URL** displayed - you'll need this for Step 2

## Step 2: Create OAuth Credentials in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** → **OAuth consent screen**
4. Configure the consent screen:
   - **User Type**: External (for testing, can use Internal for Google Workspace)
   - **App name**: PRM (or your app name)
   - **User support email**: Your email
   - **Developer contact**: Your email
5. Add **Scopes** (click "Add or Remove Scopes"):
   - `https://www.googleapis.com/auth/gmail.readonly` - Read emails
   - `https://www.googleapis.com/auth/gmail.send` - Send emails
   - `https://www.googleapis.com/auth/gmail.modify` - Modify email labels
6. Save and continue through the remaining consent screen steps

## Step 3: Create OAuth Client ID

1. Navigate to **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Configure:
   - **Application type**: Web application
   - **Name**: PRM Nango Integration
   - **Authorized redirect URIs**: Paste the **Callback URL from Nango** (from Step 1)
4. Click **Create**
5. Copy the **Client ID** and **Client Secret**

## Step 4: Configure Nango Integration

1. Return to Nango Dashboard → **Integrations** → **google-mail**
2. Enter the credentials from Step 3:
   - **Client ID**: Your Google OAuth Client ID
   - **Client Secret**: Your Google OAuth Client Secret
3. Verify **Scopes** are configured (use full URLs):
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
4. Save the integration

## Step 5: Test the Integration

1. In Nango Dashboard, go to **Connections** tab
2. Click **Add Test Connection**
3. Select **google-mail** integration
4. Click **Authorize** and complete Google OAuth flow
5. Verify the connection appears with status "Connected"

## Verification Checklist

- [ ] Google Mail integration added in Nango dashboard
- [ ] OAuth consent screen configured in Google Cloud Console
- [ ] OAuth credentials created with correct redirect URI
- [ ] Client ID and Secret added to Nango integration
- [ ] Scopes configured: gmail.readonly, gmail.send, gmail.modify (full URLs)
- [ ] Test connection successful

## Troubleshooting

### "redirect_uri_mismatch" Error

- Ensure the Callback URL in Google Console exactly matches what Nango shows
- Check for trailing slashes

### "access_denied" or "invalid_scope" Error

- Verify all scopes are added in Google OAuth consent screen
- If app is "unverified", add test users in Google Console

### Connection Works But No Data

- Gmail API must be enabled in Google Cloud Console
- Go to **APIs & Services** → **Library** → Search "Gmail API" → Enable

## Deploying Gmail Sync to Nango (Task 4.3)

After completing the OAuth setup above, deploy the Gmail sync function:

1. Navigate to the nango-integrations directory:
   ```bash
   cd nango-integrations
   ```

2. Add your Nango secret key to `.env`:
   ```bash
   # Get the key from Nango Dashboard → Environment Settings
   NANGO_SECRET_KEY_DEV=your-dev-key-here
   ```

3. Compile and verify the integration:
   ```bash
   nango compile
   ```

4. Deploy to Nango (requires confirmation):
   ```bash
   nango deploy dev
   ```

5. Verify deployment in Nango Dashboard:
   - Go to **Integrations** → **google-mail**
   - Check that **emails** sync is listed with 5-minute frequency
   - Verify the `/emails` endpoint is exposed

### Testing the Sync

1. Create a test connection (if not already done in Step 5 above)
2. Go to **Connections** → Your Gmail connection
3. Click **Trigger Sync** next to the emails sync
4. Check **Logs** tab for sync progress
5. Verify records appear in **Records** tab

## Webhook Configuration (Task 4.5/4.6)

To receive connection events (required for the UI to show "Connected" status):

1. In Nango Dashboard, go to **Environment Settings**
2. Scroll to **Webhooks** section
3. Enable **Send New Connection Creation Webhooks**
4. Set **Webhook URL** to your deployment URL:
   - Local: `https://your-ngrok-url.ngrok.io/api/nango/webhook` (use ngrok for local testing)
   - Production: `https://your-domain.com/api/nango/webhook`
5. Save the settings

### Local Testing with ngrok

For local development, expose your local server:

```bash
# Install ngrok if needed
brew install ngrok

# Start ngrok tunnel
ngrok http 3000

# Copy the https URL (e.g., https://abc123.ngrok.io)
# Set as webhook URL in Nango Dashboard
```

## Send Email Action (Task 4.8)

The Gmail integration includes a `send-email` action for sending emails via the action queue:

**Endpoint**: `POST /google-mail/emails`

**Input**:
- `to` (required): Recipient email address
- `subject` (required): Email subject
- `body` (required): Email body (plain text)
- `threadId` (optional): Thread ID for reply-to-thread
- `inReplyTo` (optional): Message-ID header for proper threading
- `references` (optional): References header for thread chain

**Output**:
- `id`: Gmail message ID
- `threadId`: Thread ID (same as input for replies, new for fresh emails)
- `labelIds`: Labels applied (e.g., SENT)

### Deploying the Action

1. Compile the integration:
   ```bash
   cd nango-integrations && npx nango compile
   ```

2. Deploy to Nango:
   ```bash
   npx nango deploy dev
   ```

3. Verify in Nango Dashboard → Integrations → google-mail → Actions

## Next Steps

After completing this setup:

- Task 4.4: Create /settings/integrations page with Nango Connect UI (done)
- Task 4.5/4.6: Webhook handler receives connection events and updates Convex (done)
- Task 4.8: Create Nango action for sending Gmail messages (done)
- Task 4.9: Create sendGmailMessage in packages/integrations using Nango
- Task 4.10: Wire Gmail send to action queue completion
