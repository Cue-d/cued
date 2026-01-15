# Nango Integration Setup - Slack

Task 5.1 requires manual configuration in the Nango dashboard and Slack API console.

## Prerequisites

- Nango account created at https://app.nango.dev (task 4.1)
- NANGO_SECRET_KEY already added to `.env.local`

## Step 1: Add Slack Integration in Nango

1. Log in to [Nango Dashboard](https://app.nango.dev)
2. Navigate to **Integrations** tab
3. Click **Configure New Integration**
4. Search for and select **slack**
5. Note the **Callback URL** displayed - you'll need this for Step 3

## Step 2: Create Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Configure:
   - **App Name**: PRM (or your app name)
   - **Development Slack Workspace**: Select your workspace
5. Click **Create App**

## Step 3: Configure OAuth & Permissions

1. In your Slack app settings, navigate to **OAuth & Permissions**
2. Under **Redirect URLs**, click **Add New Redirect URL**
3. Paste the **Callback URL from Nango** (from Step 1)
4. Click **Save URLs**
5. Under **Scopes**, add the following **Bot Token Scopes**:
   - `channels:read` - View basic channel info
   - `channels:history` - View messages in public channels
   - `chat:write` - Send messages as the app
   - `im:read` - View basic DM info
   - `im:history` - View messages in DMs
   - `im:write` - Start DMs with people
   - `users:read` - View user info to resolve names

## Step 4: Get Client Credentials

1. In your Slack app settings, navigate to **Basic Information**
2. Under **App Credentials**, copy:
   - **Client ID**
   - **Client Secret**

## Step 5: Configure Nango Integration

1. Return to Nango Dashboard → **Integrations** → **slack**
2. Enter the credentials from Step 4:
   - **Client ID**: Your Slack Client ID
   - **Client Secret**: Your Slack Client Secret
3. Verify **Scopes** are configured:
   - `channels:read`
   - `channels:history`
   - `chat:write`
   - `im:read`
   - `im:history`
   - `im:write`
   - `users:read`
4. Save the integration

## Step 6: Test the Integration

1. In Nango Dashboard, go to **Connections** tab
2. Click **Add Test Connection**
3. Select **slack** integration
4. Click **Authorize** and complete Slack OAuth flow
5. Verify the connection appears with status "Connected"

## Verification Checklist

- [ ] Slack integration added in Nango dashboard
- [ ] Slack app created at api.slack.com/apps
- [ ] OAuth redirect URI configured in Slack app
- [ ] All required scopes added (channels:read, channels:history, chat:write, im:read, im:history, im:write, users:read)
- [ ] Client ID and Secret added to Nango integration
- [ ] Test connection successful

## Troubleshooting

### "oauth_authorization_url_mismatch" Error

- Ensure the Redirect URL in Slack app settings exactly matches what Nango shows
- Check for trailing slashes

### "missing_scope" Error

- Verify all required scopes are added in Slack app OAuth settings
- Reinstall app to workspace if scopes were added after initial install

### Connection Works But No Data

- Verify bot is invited to channels you want to read
- For DMs, ensure `im:read` and `im:history` scopes are granted

### Can't Send Messages

- Verify `chat:write` scope is added
- Bot must be a member of the channel/conversation to send messages

## Deploying Slack Sync to Nango (Task 5.2)

After completing the OAuth setup above, create and deploy the Slack sync function:

1. Navigate to the nango-integrations directory:
   ```bash
   cd nango-integrations
   ```

2. Create the slack integration folder:
   ```bash
   mkdir -p slack/syncs
   ```

3. Create the sync files (see task 5.2 for implementation details)

4. Compile and verify the integration:
   ```bash
   nango compile
   ```

5. Deploy to Nango:
   ```bash
   nango deploy dev
   ```

6. Verify deployment in Nango Dashboard:
   - Go to **Integrations** → **slack**
   - Check that **messages** sync is listed
   - Verify the endpoint is exposed

## Webhook Configuration

Slack webhooks for real-time events are handled by the same webhook endpoint as Gmail:

- Endpoint: `/api/nango/webhook`
- Already configured in task 4.6

The webhook handler will automatically detect Slack connections and route appropriately.

## Next Steps

After completing this setup:

- Task 5.2: Create Nango Slack sync function for messages
- Task 5.3: Add Slack to integrations page with Nango Connect UI
- Task 5.4: Create Convex scheduled function to pull Slack from Nango
