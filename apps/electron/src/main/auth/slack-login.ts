// Slack login webview using Electron BrowserWindow
// Extracts xoxc- token from localStorage and d cookie from session

import { BrowserWindow, session } from 'electron'

export interface SlackLoginResult {
  success: boolean
  credentials?: {
    token: string // xoxc- token
    cookie: string // d cookie value
    teamId: string
    teamName: string
    userId: string
  }
  error?: string
}

const SLACK_URLS = {
  signIn: 'https://slack.com/signin',
  workspace: 'https://app.slack.com',
}

/**
 * Check if URL indicates user is logged into a workspace.
 * Matches patterns like:
 * - https://app.slack.com/client/T123/...
 * - https://myworkspace.slack.com/...
 * - https://app.slack.com/...
 */
function isWorkspaceUrl(url: string): boolean {
  // app.slack.com is the main workspace app
  if (url.startsWith(SLACK_URLS.workspace)) {
    return true
  }

  // myworkspace.slack.com pattern (but not slack.com/signin etc)
  const workspacePattern = /^https:\/\/[a-z0-9-]+\.slack\.com\/(client|messages|archives)/i
  return workspacePattern.test(url)
}

// Token extraction script to run in browser context
const EXTRACT_TOKEN_SCRIPT = `
  (function() {
    try {
      // Extract token from localStorage.localConfig_v2
      const localConfig = localStorage.getItem('localConfig_v2');
      if (!localConfig) return { error: 'No localConfig_v2 found' };

      const config = JSON.parse(localConfig);

      // Find the first team with a token
      const teams = config.teams || {};
      const teamIds = Object.keys(teams);

      if (teamIds.length === 0) return { error: 'No teams found in config' };

      const teamId = teamIds[0];
      const team = teams[teamId];

      if (!team || !team.token) return { error: 'No token found for team' };

      // Token should start with xoxc-
      if (!team.token.startsWith('xoxc-')) {
        return { error: 'Token does not start with xoxc-' };
      }

      return {
        token: team.token,
        teamId: teamId,
        teamName: team.name || teamId,
        userId: team.user_id || ''
      };
    } catch (e) {
      return { error: 'Failed to parse localStorage: ' + e.message };
    }
  })()
`

/**
 * Open Slack login in a BrowserWindow and wait for user to complete authentication.
 * Returns credentials on success or error on failure/cancellation.
 */
export function openSlackLogin(): Promise<SlackLoginResult> {
  return new Promise((resolve) => {
    // Create a dedicated session to avoid polluting the default session
    const slackSession = session.fromPartition('slack-login', { cache: true })

    const loginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Sign in to Slack',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: slackSession,
      },
    })

    let resolved = false
    let extractionInProgress = false

    const cleanup = () => {
      if (!loginWindow.isDestroyed()) {
        loginWindow.destroy()
      }
    }

    // Handle window close (user cancelled)
    loginWindow.on('closed', () => {
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: 'Login cancelled by user' })
      }
    })

    // Block slack:// deep links that would open the desktop app
    // Instead, navigate to the web workspace
    loginWindow.webContents.on('will-navigate', (event, url) => {
      console.log('[Slack Login] will-navigate:', url)

      if (url.startsWith('slack://')) {
        console.log('[Slack Login] Blocking slack:// deep link, extracting workspace info...')
        event.preventDefault()

        // Parse the deep link to get team/channel info
        // Formats:
        // - slack://TCKE4QSG5/magic-login/... (team ID is first path segment)
        // - slack://channel?team=T123&id=C456
        // - slack://open?team=T123
        try {
          const parsed = new URL(url)

          // First try query param
          let teamId = parsed.searchParams.get('team')

          // If not in query, check if hostname is the team ID (slack://TEAMID/...)
          if (!teamId && parsed.hostname && parsed.hostname.startsWith('T')) {
            teamId = parsed.hostname
          }

          if (teamId) {
            // Navigate to the web workspace instead
            const webUrl = `https://app.slack.com/client/${teamId}`
            console.log('[Slack Login] Redirecting to web workspace:', webUrl)
            loginWindow.loadURL(webUrl)
          } else {
            console.log('[Slack Login] Could not extract team ID from deep link')
          }
        } catch (e) {
          console.error('[Slack Login] Failed to parse deep link:', e)
        }
      }
    })

    // Also handle new window attempts (some links open in new windows)
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      console.log('[Slack Login] Window open attempt:', url)

      if (url.startsWith('slack://')) {
        console.log('[Slack Login] Blocking slack:// in new window')

        try {
          const parsed = new URL(url)
          let teamId = parsed.searchParams.get('team')
          if (!teamId && parsed.hostname && parsed.hostname.startsWith('T')) {
            teamId = parsed.hostname
          }
          if (teamId) {
            loginWindow.loadURL(`https://app.slack.com/client/${teamId}`)
          }
        } catch (e) {
          console.error('[Slack Login] Failed to parse deep link:', e)
        }

        return { action: 'deny' }
      }

      // Allow other URLs to open in the same window
      loginWindow.loadURL(url)
      return { action: 'deny' }
    })

    // Helper to attempt credential extraction with retries
    // Uses extractionInProgress flag to prevent concurrent extraction attempts
    const attemptExtraction = async (source: string): Promise<boolean> => {
      if (resolved) return true
      if (extractionInProgress) {
        console.log(`[Slack Login] ${source} - Extraction already in progress, skipping`)
        return false
      }

      const url = loginWindow.webContents.getURL()
      console.log(`[Slack Login] ${source} - URL: ${url}`)

      if (!isWorkspaceUrl(url)) {
        console.log('[Slack Login] Not a workspace URL, skipping extraction')
        return false
      }

      // Lock extraction to prevent concurrent attempts
      extractionInProgress = true

      try {
        // Try multiple times with delays - localStorage may take time to populate
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (resolved) return true

          console.log(`[Slack Login] Extraction attempt ${attempt}/3...`)
          await new Promise((r) => setTimeout(r, 1500))

          try {
            const tokenResult = await loginWindow.webContents.executeJavaScript(
              EXTRACT_TOKEN_SCRIPT
            )

            if (tokenResult.error) {
              console.log(`[Slack Login] Attempt ${attempt} - Token extraction failed:`, tokenResult.error)
              continue
            }

            // Extract d cookie from session
            const cookies = await slackSession.cookies.get({ domain: '.slack.com' })
            console.log(`[Slack Login] Found ${cookies.length} cookies for .slack.com`)
            const dCookie = cookies.find((c) => c.name === 'd')

            if (!dCookie) {
              console.log(`[Slack Login] Attempt ${attempt} - d cookie not found`)
              continue
            }

            // Success!
            console.log(`[Slack Login] Success! Team: ${tokenResult.teamName}`)
            resolved = true
            cleanup()

            resolve({
              success: true,
              credentials: {
                token: tokenResult.token,
                cookie: dCookie.value,
                teamId: tokenResult.teamId,
                teamName: tokenResult.teamName,
                userId: tokenResult.userId,
              },
            })
            return true
          } catch (error) {
            console.error(`[Slack Login] Attempt ${attempt} error:`, error)
          }
        }

        console.log('[Slack Login] All extraction attempts failed, keeping window open')
        return false
      } finally {
        extractionInProgress = false
      }
    }

    // Monitor navigation to detect successful login
    loginWindow.webContents.on('did-navigate', async (_event, url) => {
      console.log('[Slack Login] did-navigate:', url)
      await attemptExtraction('did-navigate')
    })

    // Also check on page load completion
    loginWindow.webContents.on('did-finish-load', async () => {
      console.log('[Slack Login] did-finish-load:', loginWindow.webContents.getURL())
      await attemptExtraction('did-finish-load')
    })

    // Also check when DOM is ready (sometimes fires when did-navigate doesn't)
    loginWindow.webContents.on('dom-ready', async () => {
      console.log('[Slack Login] dom-ready:', loginWindow.webContents.getURL())
      // Small delay to let JS initialize
      await new Promise((r) => setTimeout(r, 500))
      await attemptExtraction('dom-ready')
    })

    // Load the Slack sign-in page
    console.log('[Slack Login] Opening login window...')
    loginWindow.loadURL(SLACK_URLS.signIn)
  })
}

/**
 * Clear Slack session cookies and storage.
 */
export async function clearSlackSession(): Promise<void> {
  const slackSession = session.fromPartition('slack-login', { cache: true })

  await slackSession.clearStorageData({
    storages: ['cookies', 'localstorage'],
  })
}
