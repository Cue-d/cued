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
3. Verify **Scopes** are configured:
   - `gmail.readonly`
   - `gmail.send`
   - `gmail.modify`
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
- [ ] Scopes configured: gmail.readonly, gmail.send, gmail.modify
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

## Next Steps

After completing this setup:
- Task 4.3: Create Nango Gmail sync function for emails
- Task 4.4: Create /settings/integrations page with Nango Connect UI

## Important Notes

- Gmail API scopes are **restricted** - for production you'll need Google verification
- For development/testing, add your Google account as a test user in OAuth consent screen
- The integration-id `google-mail` is what you'll use in code when calling Nango APIs
