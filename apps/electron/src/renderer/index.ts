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
    }
  } catch (error) {
    console.error('Failed to get auth state:', error)
    showState('login')
  }
}

init()
