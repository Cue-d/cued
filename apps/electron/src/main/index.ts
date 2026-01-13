import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import {
  initAuth,
  getAuthState,
  startDeviceAuth,
  signOut,
} from './auth'

// WorkOS Client ID - should match web app config
// In production, this would be loaded from a config file or env
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_01JZDHMFDC22NTPTWYKPR32P73'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // In development, load from dev server
  // In production, load from built files
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupAuthIpcHandlers(): void {
  // Get current auth state
  ipcMain.handle('auth:getState', () => {
    return getAuthState()
  })

  // Start device authorization flow
  ipcMain.handle('auth:startLogin', async () => {
    await startDeviceAuth({
      onUserCode: (code, uri) => {
        // Notify renderer to display user code
        mainWindow?.webContents.send('auth:userCode', code, uri)
      },
      onAuthSuccess: (user) => {
        // Notify renderer of auth state change
        mainWindow?.webContents.send('auth:stateChanged', {
          isAuthenticated: true,
          user,
        })
      },
      onAuthError: (error) => {
        // Notify renderer of auth failure
        mainWindow?.webContents.send('auth:stateChanged', {
          isAuthenticated: false,
          user: null,
          error,
        })
      },
    })
  })

  // Sign out
  ipcMain.handle('auth:signOut', () => {
    signOut()
    mainWindow?.webContents.send('auth:stateChanged', {
      isAuthenticated: false,
      user: null,
    })
  })
}

app.whenReady().then(() => {
  // Initialize auth with WorkOS client ID
  initAuth(WORKOS_CLIENT_ID)

  // Set up IPC handlers before creating window
  setupAuthIpcHandlers()

  createWindow()

  // Check initial auth state and notify renderer once window is ready
  mainWindow?.webContents.once('did-finish-load', () => {
    const authState = getAuthState()
    mainWindow?.webContents.send('auth:stateChanged', authState)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
