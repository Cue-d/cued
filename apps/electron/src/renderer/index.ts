// Renderer process entry point
export {}

interface AuthUser {
  id: string
  email: string
  name: string | null
}

interface AuthState {
  isAuthenticated: boolean
  user: AuthUser | null
}

interface SyncProgress {
  status: 'idle' | 'syncing' | 'error' | 'recovery'
  lastSyncAt?: number
  lastCursor?: number
  totalMessagesSynced: number
  totalContactsSynced?: number
  currentBatch?: {
    messagesInBatch: number
    batchNumber: number
    estimatedBatchesRemaining: number
  }
  error?: string
  recoveryReason?: string
}

interface SocialStatusResult {
  isLoggedIn: boolean
  error?: string
}

interface SocialScrapeResult {
  success: boolean
  data?: unknown[]
  error?: string
  count?: number
}

interface SocialProgress {
  status: 'starting' | 'complete' | 'error'
  count?: number
  type?: string
  error?: string
}

interface LinkedInMessagingStatus {
  connected: boolean
  syncProgress?: LinkedInSyncProgress
  error?: string
}

interface LinkedInSyncProgress {
  status: 'idle' | 'syncing' | 'error'
  conversationsSynced: number
  messagesSynced: number
  lastSyncAt?: number
  error?: string
}

interface LinkedInSyncResult {
  success: boolean
  error?: string
}

declare global {
  interface Window {
    electron: {
      versions: {
        node: () => string
        chrome: () => string
        electron: () => string
      }
      auth: {
        getState: () => Promise<AuthState>
        startLogin: () => Promise<void>
        signOut: () => Promise<void>
        onAuthChange: (callback: (state: AuthState) => void) => () => void
        onUserCode: (callback: (code: string, uri: string) => void) => () => void
      }
      sync: {
        getProgress: () => Promise<SyncProgress>
        runNow: () => Promise<SyncProgress>
        reset: () => Promise<SyncProgress>
        forceFullSync: () => Promise<SyncProgress>
        onProgress: (callback: (progress: SyncProgress) => void) => () => void
      }
      social: {
        // LinkedIn - Contact Scraping
        linkedinStatus: () => Promise<SocialStatusResult>
        linkedinLogin: () => Promise<SocialStatusResult>
        linkedinScrape: (options?: { maxConnections?: number }) => Promise<SocialScrapeResult>
        // LinkedIn - Messaging Sync
        linkedinMessagingStatus: () => Promise<LinkedInMessagingStatus>
        linkedinStartMessagingSync: () => Promise<LinkedInSyncResult>
        linkedinStopMessagingSync: () => Promise<LinkedInSyncResult>
        linkedinSendMessage: (conversationId: string, text: string) => Promise<unknown>
        linkedinGetSyncProgress: () => Promise<LinkedInSyncProgress>
        // Twitter
        twitterStatus: () => Promise<SocialStatusResult>
        twitterLogin: () => Promise<SocialStatusResult>
        twitterScrapeMutuals: (username: string, options?: { maxUsers?: number }) => Promise<SocialScrapeResult>
        // Progress listeners
        onLinkedinProgress: (callback: (progress: SocialProgress) => void) => () => void
        onLinkedinMessagingSyncProgress: (callback: (progress: LinkedInSyncProgress) => void) => () => void
        onLinkedinAuthInvalid: (callback: () => void) => () => void
        onTwitterProgress: (callback: (progress: SocialProgress) => void) => () => void
      }
    }
  }
}

// UI Elements
const loadingEl = document.getElementById('loading')
const loginEl = document.getElementById('login')
const deviceCodeEl = document.getElementById('device-code')
const authenticatedEl = document.getElementById('authenticated')
const loginBtn = document.getElementById('loginBtn')
const signOutBtn = document.getElementById('signOutBtn')
const forceSyncBtn = document.getElementById('forceSyncBtn')
const codeDisplayEl = document.getElementById('codeDisplay')
const userNameEl = document.getElementById('userName')
const userEmailEl = document.getElementById('userEmail')
const syncProgressTextEl = document.getElementById('syncProgressText')
const syncRateEl = document.getElementById('syncRate')
const progressBarContainerEl = document.getElementById('progressBarContainer')
const progressBarEl = document.getElementById('progressBar')
const syncDetailsEl = document.getElementById('syncDetails')
const versionsEl = document.getElementById('versions')

// Social UI Elements
const linkedinStatusEl = document.getElementById('linkedinStatus')
const linkedinLoginBtn = document.getElementById('linkedinLoginBtn')
const linkedinScrapeBtn = document.getElementById('linkedinScrapeBtn')
const linkedinProgressEl = document.getElementById('linkedinProgress')
// LinkedIn Messaging Sync UI
const linkedinMessagingStatusEl = document.getElementById('linkedinMessagingStatus')
const linkedinStartSyncBtn = document.getElementById('linkedinStartSyncBtn')
const linkedinStopSyncBtn = document.getElementById('linkedinStopSyncBtn')
const linkedinMessagingProgressEl = document.getElementById('linkedinMessagingProgress')
// Twitter UI
const twitterStatusEl = document.getElementById('twitterStatus')
const twitterLoginBtn = document.getElementById('twitterLoginBtn')
const twitterScrapeBtn = document.getElementById('twitterScrapeBtn')
const twitterUsernameEl = document.getElementById('twitterUsername') as HTMLInputElement | null
const twitterProgressEl = document.getElementById('twitterProgress')

// Track sync rate calculation
let syncStartTime: number | null = null
let syncStartMessages: number = 0

type UIState = 'loading' | 'login' | 'device-code' | 'authenticated'

function showState(state: UIState): void {
  loadingEl?.classList.toggle('hidden', state !== 'loading')
  loginEl?.classList.toggle('hidden', state !== 'login')
  deviceCodeEl?.classList.toggle('hidden', state !== 'device-code')
  authenticatedEl?.classList.toggle('hidden', state !== 'authenticated')
}

function updateUI(authState: AuthState): void {
  if (authState.isAuthenticated && authState.user) {
    if (userNameEl) userNameEl.textContent = authState.user.name || 'User'
    if (userEmailEl) userEmailEl.textContent = authState.user.email
    showState('authenticated')
  } else {
    showState('login')
  }
}

function updateSyncUI(progress: SyncProgress): void {
  if (!syncProgressTextEl || !syncDetailsEl) return

  const statusText: Record<SyncProgress['status'], string> = {
    idle: '✓ Idle',
    syncing: '↻ Syncing...',
    error: '✗ Error',
    recovery: '↻ Recovery in progress...',
  }

  syncProgressTextEl.textContent = statusText[progress.status] || progress.status

  // Calculate and display sync rate
  if (progress.status === 'syncing' || progress.status === 'recovery') {
    if (syncStartTime === null) {
      syncStartTime = Date.now()
      syncStartMessages = progress.totalMessagesSynced
    }

    const elapsedSeconds = (Date.now() - syncStartTime) / 1000
    const messagesSynced = progress.totalMessagesSynced - syncStartMessages
    const rate = elapsedSeconds > 0 ? Math.round(messagesSynced / elapsedSeconds) : 0

    if (rate > 0 && syncRateEl) {
      syncRateEl.textContent = `${rate.toLocaleString()} msg/s`
      syncRateEl.classList.remove('hidden')
    }

    // Show progress bar if we have batch info
    if (progress.currentBatch && progressBarContainerEl && progressBarEl) {
      const batchNum = progress.currentBatch.batchNumber
      const remaining = progress.currentBatch.estimatedBatchesRemaining
      const total = batchNum + remaining
      const percent = total > 0 ? Math.round((batchNum / total) * 100) : 0
      progressBarEl.style.width = `${percent}%`
      progressBarContainerEl.classList.remove('hidden')
    }
  } else {
    // Reset tracking when not syncing
    syncStartTime = null
    syncStartMessages = 0
    syncRateEl?.classList.add('hidden')
    progressBarContainerEl?.classList.add('hidden')
  }

  const details: string[] = []

  if (progress.recoveryReason) {
    details.push(`Recovery: ${progress.recoveryReason}`)
  }

  if (progress.currentBatch) {
    details.push(
      `Batch ${progress.currentBatch.batchNumber}: ${progress.currentBatch.messagesInBatch.toLocaleString()} messages`
    )
    if (progress.currentBatch.estimatedBatchesRemaining > 0) {
      details.push(`~${progress.currentBatch.estimatedBatchesRemaining} batches remaining`)
    }
  }

  if (progress.totalMessagesSynced > 0) {
    details.push(`${progress.totalMessagesSynced.toLocaleString()} messages synced`)
  }

  if (progress.totalContactsSynced && progress.totalContactsSynced > 0) {
    details.push(`${progress.totalContactsSynced.toLocaleString()} contacts synced`)
  }

  if (progress.lastSyncAt) {
    const lastSync = new Date(progress.lastSyncAt)
    details.push(`Last sync: ${lastSync.toLocaleTimeString()}`)
  }

  if (progress.error) {
    details.push(`Error: ${progress.error}`)
  }

  syncDetailsEl.innerHTML = details.map(d => `<div>${d}</div>`).join('')
}

async function init(): Promise<void> {
  if (!window.electron) {
    console.error('Electron API not available')
    return
  }

  // Display version info
  if (versionsEl) {
    versionsEl.innerHTML = `
      Electron ${window.electron.versions.electron()} · Chrome ${window.electron.versions.chrome()} · Node ${window.electron.versions.node()}
    `
  }

  // Listen for auth state changes
  window.electron.auth.onAuthChange((state) => {
    updateUI(state)
  })

  // Listen for user code display during device auth
  window.electron.auth.onUserCode((code) => {
    if (codeDisplayEl) codeDisplayEl.textContent = code
    showState('device-code')
  })

  // Login button handler
  loginBtn?.addEventListener('click', async () => {
    loginBtn.setAttribute('disabled', 'true')
    loginBtn.textContent = 'Opening browser...'
    try {
      await window.electron.auth.startLogin()
    } catch (error) {
      console.error('Login failed:', error)
      loginBtn.removeAttribute('disabled')
      loginBtn.textContent = 'Sign In'
      showState('login')
    }
  })

  // Sign out button handler
  signOutBtn?.addEventListener('click', async () => {
    await window.electron.auth.signOut()
  })

  // Force full sync button handler
  forceSyncBtn?.addEventListener('click', async () => {
    if (!confirm('This will re-sync all messages and contacts from your Mac. Continue?')) {
      return
    }
    forceSyncBtn.setAttribute('disabled', 'true')
    forceSyncBtn.textContent = 'Syncing...'
    try {
      await window.electron.sync.forceFullSync()
    } catch (error) {
      console.error('Force sync failed:', error)
    } finally {
      forceSyncBtn.removeAttribute('disabled')
      forceSyncBtn.textContent = 'Force Full Sync'
    }
  })

  // Listen for sync progress updates
  window.electron.sync.onProgress((progress) => {
    updateSyncUI(progress)
  })

  // Get initial auth state
  try {
    const state = await window.electron.auth.getState()
    updateUI(state)

    // Get initial sync progress if authenticated
    if (state.isAuthenticated) {
      const syncProgress = await window.electron.sync.getProgress()
      updateSyncUI(syncProgress)

      // Check social login status
      checkSocialStatus()
    }
  } catch (error) {
    console.error('Failed to get auth state:', error)
    showState('login')
  }

  // Set up social handlers
  setupSocialHandlers()
}

// ============================================================================
// Social Scraper Functions
// ============================================================================

async function checkSocialStatus(): Promise<void> {
  // Check LinkedIn status
  try {
    const linkedinResult = await window.electron.social.linkedinStatus()
    updateLinkedinStatus(linkedinResult.isLoggedIn)

    // Also check messaging sync status
    if (linkedinResult.isLoggedIn) {
      const messagingStatus = await window.electron.social.linkedinMessagingStatus()
      if (messagingStatus.syncProgress) {
        updateLinkedinMessagingStatus(messagingStatus.syncProgress)
      }
    }
  } catch (error) {
    console.error('Failed to check LinkedIn status:', error)
    if (linkedinStatusEl) linkedinStatusEl.textContent = 'Error checking status'
  }

  // Check Twitter status
  try {
    const twitterResult = await window.electron.social.twitterStatus()
    updateTwitterStatus(twitterResult.isLoggedIn)
  } catch (error) {
    console.error('Failed to check Twitter status:', error)
    if (twitterStatusEl) twitterStatusEl.textContent = 'Error checking status'
  }
}

function updateLinkedinStatus(isLoggedIn: boolean): void {
  if (linkedinStatusEl) {
    linkedinStatusEl.textContent = isLoggedIn ? '✓ Logged in' : 'Not logged in'
    linkedinStatusEl.style.color = isLoggedIn ? '#22c55e' : ''
  }
  if (linkedinScrapeBtn) {
    (linkedinScrapeBtn as HTMLButtonElement).disabled = !isLoggedIn
  }
  // Enable messaging sync button when logged in
  if (linkedinStartSyncBtn) {
    (linkedinStartSyncBtn as HTMLButtonElement).disabled = !isLoggedIn
  }
}

function updateLinkedinMessagingStatus(progress: LinkedInSyncProgress): void {
  if (linkedinMessagingStatusEl) {
    if (progress.status === 'syncing') {
      linkedinMessagingStatusEl.textContent = '↻ Syncing...'
      linkedinMessagingStatusEl.style.color = '#22c55e'
    } else if (progress.status === 'error') {
      linkedinMessagingStatusEl.textContent = `✗ Error: ${progress.error}`
      linkedinMessagingStatusEl.style.color = '#ef4444'
    } else {
      linkedinMessagingStatusEl.textContent = progress.lastSyncAt
        ? `Last sync: ${new Date(progress.lastSyncAt).toLocaleTimeString()}`
        : 'Not syncing'
      linkedinMessagingStatusEl.style.color = ''
    }
  }

  // Update progress display
  if (linkedinMessagingProgressEl) {
    if (progress.status === 'syncing') {
      linkedinMessagingProgressEl.style.display = 'block'
      linkedinMessagingProgressEl.textContent =
        `${progress.conversationsSynced} conversations, ${progress.messagesSynced} messages`
      linkedinMessagingProgressEl.style.color = ''
    } else if (progress.status === 'error') {
      linkedinMessagingProgressEl.style.display = 'block'
      linkedinMessagingProgressEl.textContent = progress.error ?? 'Unknown error'
      linkedinMessagingProgressEl.style.color = '#ef4444'
    } else if (progress.messagesSynced > 0) {
      linkedinMessagingProgressEl.style.display = 'block'
      linkedinMessagingProgressEl.textContent =
        `✓ ${progress.conversationsSynced} conversations, ${progress.messagesSynced} messages`
      linkedinMessagingProgressEl.style.color = '#22c55e'
    }
  }

  // Update button states
  const isSyncing = progress.status === 'syncing'
  if (linkedinStartSyncBtn) {
    (linkedinStartSyncBtn as HTMLButtonElement).disabled = isSyncing
  }
  if (linkedinStopSyncBtn) {
    (linkedinStopSyncBtn as HTMLButtonElement).disabled = !isSyncing
  }
}

function updateTwitterStatus(isLoggedIn: boolean): void {
  if (twitterStatusEl) {
    twitterStatusEl.textContent = isLoggedIn ? '✓ Logged in' : 'Not logged in'
    twitterStatusEl.style.color = isLoggedIn ? '#22c55e' : ''
  }
  if (twitterScrapeBtn) {
    (twitterScrapeBtn as HTMLButtonElement).disabled = !isLoggedIn
  }
}

function setupSocialHandlers(): void {
  // LinkedIn login
  linkedinLoginBtn?.addEventListener('click', async () => {
    linkedinLoginBtn.setAttribute('disabled', 'true')
    linkedinLoginBtn.textContent = 'Opening...'
    if (linkedinStatusEl) linkedinStatusEl.textContent = 'Opening browser...'

    try {
      const result = await window.electron.social.linkedinLogin()
      updateLinkedinStatus(result.isLoggedIn)
      if (!result.isLoggedIn && result.error) {
        if (linkedinStatusEl) linkedinStatusEl.textContent = `Error: ${result.error}`
      }
    } catch (error) {
      console.error('LinkedIn login failed:', error)
      if (linkedinStatusEl) linkedinStatusEl.textContent = 'Login failed'
    } finally {
      linkedinLoginBtn.removeAttribute('disabled')
      linkedinLoginBtn.textContent = 'Login'
    }
  })

  // LinkedIn scrape
  linkedinScrapeBtn?.addEventListener('click', async () => {
    linkedinScrapeBtn.setAttribute('disabled', 'true')
    linkedinScrapeBtn.textContent = 'Scraping...'
    if (linkedinProgressEl) {
      linkedinProgressEl.style.display = 'block'
      linkedinProgressEl.textContent = 'Starting scrape...'
    }

    try {
      const result = await window.electron.social.linkedinScrape()
      if (result.success) {
        if (linkedinProgressEl) {
          linkedinProgressEl.textContent = `✓ Scraped ${result.count} connections`
          linkedinProgressEl.style.color = '#22c55e'
        }
      } else {
        if (linkedinProgressEl) {
          linkedinProgressEl.textContent = `Error: ${result.error}`
          linkedinProgressEl.style.color = '#ef4444'
        }
      }
    } catch (error) {
      console.error('LinkedIn scrape failed:', error)
      if (linkedinProgressEl) {
        linkedinProgressEl.textContent = 'Scrape failed'
        linkedinProgressEl.style.color = '#ef4444'
      }
    } finally {
      linkedinScrapeBtn.removeAttribute('disabled')
      linkedinScrapeBtn.textContent = 'Scrape'
    }
  })

  // LinkedIn messaging sync - start
  linkedinStartSyncBtn?.addEventListener('click', async () => {
    linkedinStartSyncBtn.setAttribute('disabled', 'true')
    linkedinStartSyncBtn.textContent = 'Starting...'
    if (linkedinMessagingStatusEl) linkedinMessagingStatusEl.textContent = 'Starting sync...'

    try {
      const result = await window.electron.social.linkedinStartMessagingSync()
      if (result.success) {
        if (linkedinStopSyncBtn) {
          (linkedinStopSyncBtn as HTMLButtonElement).disabled = false
        }
        if (linkedinMessagingStatusEl) {
          linkedinMessagingStatusEl.textContent = '↻ Syncing...'
          linkedinMessagingStatusEl.style.color = '#22c55e'
        }
      } else {
        if (linkedinMessagingStatusEl) {
          linkedinMessagingStatusEl.textContent = `Error: ${result.error}`
          linkedinMessagingStatusEl.style.color = '#ef4444'
        }
        linkedinStartSyncBtn.removeAttribute('disabled')
      }
    } catch (error) {
      console.error('LinkedIn messaging sync start failed:', error)
      if (linkedinMessagingStatusEl) {
        linkedinMessagingStatusEl.textContent = 'Start failed'
        linkedinMessagingStatusEl.style.color = '#ef4444'
      }
      linkedinStartSyncBtn.removeAttribute('disabled')
    } finally {
      linkedinStartSyncBtn.textContent = 'Start'
    }
  })

  // LinkedIn messaging sync - stop
  linkedinStopSyncBtn?.addEventListener('click', async () => {
    linkedinStopSyncBtn.setAttribute('disabled', 'true')
    linkedinStopSyncBtn.textContent = 'Stopping...'

    try {
      const result = await window.electron.social.linkedinStopMessagingSync()
      if (result.success) {
        if (linkedinStartSyncBtn) {
          (linkedinStartSyncBtn as HTMLButtonElement).disabled = false
        }
        if (linkedinMessagingStatusEl) {
          linkedinMessagingStatusEl.textContent = 'Stopped'
          linkedinMessagingStatusEl.style.color = ''
        }
      } else {
        if (linkedinMessagingStatusEl) {
          linkedinMessagingStatusEl.textContent = `Error: ${result.error}`
          linkedinMessagingStatusEl.style.color = '#ef4444'
        }
      }
    } catch (error) {
      console.error('LinkedIn messaging sync stop failed:', error)
      if (linkedinMessagingStatusEl) {
        linkedinMessagingStatusEl.textContent = 'Stop failed'
        linkedinMessagingStatusEl.style.color = '#ef4444'
      }
    } finally {
      linkedinStopSyncBtn.removeAttribute('disabled')
      linkedinStopSyncBtn.textContent = 'Stop'
    }
  })

  // Twitter login
  twitterLoginBtn?.addEventListener('click', async () => {
    twitterLoginBtn.setAttribute('disabled', 'true')
    twitterLoginBtn.textContent = 'Opening...'
    if (twitterStatusEl) twitterStatusEl.textContent = 'Opening browser...'

    try {
      const result = await window.electron.social.twitterLogin()
      updateTwitterStatus(result.isLoggedIn)
      if (!result.isLoggedIn && result.error) {
        if (twitterStatusEl) twitterStatusEl.textContent = `Error: ${result.error}`
      }
    } catch (error) {
      console.error('Twitter login failed:', error)
      if (twitterStatusEl) twitterStatusEl.textContent = 'Login failed'
    } finally {
      twitterLoginBtn.removeAttribute('disabled')
      twitterLoginBtn.textContent = 'Login'
    }
  })

  // Twitter scrape mutuals
  twitterScrapeBtn?.addEventListener('click', async () => {
    const username = twitterUsernameEl?.value?.replace(/^@/, '').trim()
    if (!username) {
      if (twitterProgressEl) {
        twitterProgressEl.style.display = 'block'
        twitterProgressEl.textContent = 'Please enter a username'
        twitterProgressEl.style.color = '#ef4444'
      }
      return
    }

    twitterScrapeBtn.setAttribute('disabled', 'true')
    twitterScrapeBtn.textContent = 'Scraping...'
    if (twitterProgressEl) {
      twitterProgressEl.style.display = 'block'
      twitterProgressEl.textContent = `Scraping mutuals for @${username}...`
      twitterProgressEl.style.color = ''
    }

    try {
      const result = await window.electron.social.twitterScrapeMutuals(username)
      if (result.success) {
        if (twitterProgressEl) {
          twitterProgressEl.textContent = `✓ Found ${result.count} mutuals`
          twitterProgressEl.style.color = '#22c55e'
        }
      } else {
        if (twitterProgressEl) {
          twitterProgressEl.textContent = `Error: ${result.error}`
          twitterProgressEl.style.color = '#ef4444'
        }
      }
    } catch (error) {
      console.error('Twitter scrape failed:', error)
      if (twitterProgressEl) {
        twitterProgressEl.textContent = 'Scrape failed'
        twitterProgressEl.style.color = '#ef4444'
      }
    } finally {
      twitterScrapeBtn.removeAttribute('disabled')
      twitterScrapeBtn.textContent = 'Scrape'
    }
  })

  // Progress listeners
  window.electron.social.onLinkedinProgress((progress) => {
    if (linkedinProgressEl) {
      linkedinProgressEl.style.display = 'block'
      if (progress.status === 'starting') {
        linkedinProgressEl.textContent = 'Scraping...'
      } else if (progress.status === 'complete') {
        linkedinProgressEl.textContent = `✓ Scraped ${progress.count} connections`
        linkedinProgressEl.style.color = '#22c55e'
      } else if (progress.status === 'error') {
        linkedinProgressEl.textContent = `Error: ${progress.error}`
        linkedinProgressEl.style.color = '#ef4444'
      }
    }
  })

  // LinkedIn messaging sync progress listener
  window.electron.social.onLinkedinMessagingSyncProgress((progress) => {
    updateLinkedinMessagingStatus(progress)
  })

  // LinkedIn auth invalid listener - prompt re-login
  window.electron.social.onLinkedinAuthInvalid(() => {
    console.log('LinkedIn auth invalid, prompting re-login')
    updateLinkedinStatus(false)
    if (linkedinMessagingStatusEl) {
      linkedinMessagingStatusEl.textContent = 'Auth expired - please login again'
      linkedinMessagingStatusEl.style.color = '#ef4444'
    }
    if (linkedinStopSyncBtn) {
      (linkedinStopSyncBtn as HTMLButtonElement).disabled = true
    }
  })

  window.electron.social.onTwitterProgress((progress) => {
    if (twitterProgressEl) {
      twitterProgressEl.style.display = 'block'
      if (progress.status === 'starting') {
        twitterProgressEl.textContent = `Scraping ${progress.type}...`
      } else if (progress.status === 'complete') {
        twitterProgressEl.textContent = `✓ Found ${progress.count} ${progress.type}`
        twitterProgressEl.style.color = '#22c55e'
      } else if (progress.status === 'error') {
        twitterProgressEl.textContent = `Error: ${progress.error}`
        twitterProgressEl.style.color = '#ef4444'
      }
    }
  })
}

init()
