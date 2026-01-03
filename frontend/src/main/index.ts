import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'

const API_BASE = 'http://localhost:8000'

let backendProcess: ChildProcess | null = null

// Start backend server
function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const isDev = !app.isPackaged

    // In development, assume backend is running manually
    if (isDev) {
      console.log('Development mode: assuming backend is running on localhost:8000')
      resolve()
      return
    }

    // In production, launch the bundled backend executable
    const backendPath = join(process.resourcesPath, 'backend', 'prm-backend')
    console.log('Starting backend from:', backendPath)

    backendProcess = spawn(backendPath, [], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    backendProcess.stdout?.on('data', (data) => {
      console.log('[Backend]', data.toString())
    })

    backendProcess.stderr?.on('data', (data) => {
      console.error('[Backend Error]', data.toString())
    })

    backendProcess.on('error', (error) => {
      console.error('Failed to start backend:', error)
      reject(error)
    })

    backendProcess.on('exit', (code) => {
      console.log('Backend process exited with code:', code)
      backendProcess = null
    })

    // Give backend time to start
    setTimeout(() => {
      console.log('Backend should be ready')
      resolve()
    }, 2000)
  })
}

// Register IPC handlers
function registerIpcHandlers(): void {
  // IPC handlers for API calls
  ipcMain.handle('api:getChats', async (_, limit = 50, offset = 0) => {
    const res = await fetch(`${API_BASE}/chats?limit=${limit}&offset=${offset}`)
    if (!res.ok) throw new Error(`Failed to fetch chats: ${res.status}`)
    return res.json()
  })

  ipcMain.handle('api:getMessages', async (_, chatId: number, limit = 100) => {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages?limit=${limit}`)
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`)
    return res.json()
  })

  ipcMain.handle('api:sendMessage', async (_, chatId: number, text: string) => {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
    if (!res.ok) throw new Error(`Failed to send message: ${res.status}`)
    return res.json()
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the remote URL for development or the local html file for production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  await startBackend()
  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up backend process when app quits
app.on('before-quit', () => {
  if (backendProcess) {
    console.log('Killing backend process...')
    backendProcess.kill()
    backendProcess = null
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
