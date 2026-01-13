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
const codeDisplayEl = document.getElementById('codeDisplay')
const userNameEl = document.getElementById('userName')
const userEmailEl = document.getElementById('userEmail')
const versionsEl = document.getElementById('versions')

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

  // Get initial auth state
  try {
    const state = await window.electron.auth.getState()
    updateUI(state)
  } catch (error) {
    console.error('Failed to get auth state:', error)
    showState('login')
  }
}

init()
