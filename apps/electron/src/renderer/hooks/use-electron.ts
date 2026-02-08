import { useCallback, useEffect, useState } from "react"
import type { ElectronAPI } from "../../shared/electron-api"

// Re-export all types from shared for consumers that import from this file
export type {
  AuthUser,
  AuthState,
  PlatformSyncResult,
  UnifiedSyncProgress,
  UnifiedSyncResult,
  LinkedInStatusResult,
  LinkedInSyncProgress,
  LinkedInSendMessageResult,
  TwitterStatusResult,
  TwitterSyncProgress,
  TwitterSendMessageResult,
  SignalStatusResult,
  SignalSyncProgress,
  SignalSendMessageResult,
  SignalLoginCredentials,
  SignalSetupResult,
  SignalLoginResult,
  SlackSyncProgress,
  SlackWorkspaceInfo,
  SlackStatusResult,
  SlackLoginResult,
  SlackDisconnectResult,
} from "../../shared/electron-api"

import type {
  AuthState,
  PlatformSyncResult,
  UnifiedSyncProgress,
  UnifiedSyncResult,
  LinkedInStatusResult,
  LinkedInSendMessageResult,
  TwitterStatusResult,
  TwitterSendMessageResult,
  SignalLoginCredentials,
  SignalSetupResult,
  SignalLoginResult,
  SignalSendMessageResult,
  SlackWorkspaceInfo,
  SlackLoginResult,
  SlackDisconnectResult,
} from "../../shared/electron-api"

// Window Type Declaration
// ----------------------------------------------------------------------------

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

// Hooks
// ----------------------------------------------------------------------------

export function useElectron(): Window["electron"] {
  if (!window.electron) {
    throw new Error("Electron API not available - preload script may have failed to load")
  }
  return window.electron
}

interface UseAuthStateReturn extends AuthState {
  isLoading: boolean
  login: () => Promise<void>
  signOut: () => Promise<void>
  userCode: string | null
}

export function useAuthState(): UseAuthStateReturn {
  const [state, setState] = useState<AuthState>({ isAuthenticated: false, user: null })
  const [isLoading, setIsLoading] = useState(true)
  const [userCode, setUserCode] = useState<string | null>(null)
  const electron = useElectron()

  useEffect(() => {
    electron.auth.getState().then((s) => {
      setState(s)
      setIsLoading(false)
    })

    const unsubAuth = electron.auth.onAuthChange((s) => {
      setState(s)
      setUserCode(null)
    })

    const unsubCode = electron.auth.onUserCode((code) => setUserCode(code))

    return () => {
      unsubAuth()
      unsubCode()
    }
  }, [electron])

  const login = useCallback(() => electron.auth.startLogin(), [electron])
  const signOut = useCallback(() => electron.auth.signOut(), [electron])

  return { ...state, isLoading, login, signOut, userCode }
}

interface UseUnifiedSyncReturn {
  currentPlatform: UnifiedSyncProgress["currentPlatform"]
  error: string | undefined
  isLoading: boolean
  isSyncing: boolean
  lastSyncAt: number | undefined
  platforms: PlatformSyncResult
  progress: UnifiedSyncProgress
  runAll: () => Promise<UnifiedSyncResult>
  runNow: () => Promise<UnifiedSyncResult>
}

export function useUnifiedSync(): UseUnifiedSyncReturn {
  const [progress, setProgress] = useState<UnifiedSyncProgress>({ status: "idle", platforms: {} })
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  useEffect(() => {
    electron.sync.getProgress().then((p) => {
      setProgress(p)
      setIsLoading(false)
    })
    return electron.sync.onProgress(setProgress)
  }, [electron])

  const runNow = useCallback(() => electron.sync.runNow(), [electron])
  const runAll = useCallback(() => electron.sync.runAll(), [electron])

  return {
    currentPlatform: progress.currentPlatform,
    error: progress.error,
    isLoading,
    isSyncing: progress.status === "syncing",
    lastSyncAt: progress.lastSyncAt,
    platforms: progress.platforms,
    progress,
    runAll,
    runNow,
  }
}

interface UseLinkedInReturn {
  isLoading: boolean
  isLoggedIn: boolean
  login: () => Promise<LinkedInStatusResult>
  logout: () => Promise<{ error?: string; success: boolean }>
  sendMessage: (conversationId: string, text: string) => Promise<LinkedInSendMessageResult>
}

export function useLinkedIn(): UseLinkedInReturn {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  useEffect(() => {
    electron.sync.linkedin.status().then((result) => {
      setIsLoggedIn(result.isLoggedIn)
      setIsLoading(false)
    })
  }, [electron])

  const login = useCallback(async () => {
    const result = await electron.sync.linkedin.login()
    setIsLoggedIn(result.isLoggedIn)
    return result
  }, [electron])

  const logout = useCallback(async () => {
    const result = await electron.sync.linkedin.logout()
    if (result.success) setIsLoggedIn(false)
    return result
  }, [electron])

  const sendMessage = useCallback(
    (conversationId: string, text: string) => electron.sync.linkedin.sendMessage(conversationId, text),
    [electron]
  )

  return { isLoading, isLoggedIn, login, logout, sendMessage }
}

interface UseTwitterReturn {
  isLoading: boolean
  isLoggedIn: boolean
  login: () => Promise<TwitterStatusResult>
  logout: () => Promise<{ error?: string; success: boolean }>
  sendMessage: (conversationId: string, text: string) => Promise<TwitterSendMessageResult>
}

export function useTwitter(): UseTwitterReturn {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  useEffect(() => {
    electron.sync.twitter.status().then((result) => {
      setIsLoggedIn(result.isLoggedIn)
      setIsLoading(false)
    })
  }, [electron])

  const login = useCallback(async () => {
    const result = await electron.sync.twitter.login()
    setIsLoggedIn(result.isLoggedIn)
    return result
  }, [electron])

  const logout = useCallback(async () => {
    const result = await electron.sync.twitter.logout()
    if (result.success) setIsLoggedIn(false)
    return result
  }, [electron])

  const sendMessage = useCallback(
    (conversationId: string, text: string) => electron.sync.twitter.sendMessage(conversationId, text),
    [electron]
  )

  return { isLoading, isLoggedIn, login, logout, sendMessage }
}

interface UseSlackReturn {
  disconnect: (teamId?: string) => Promise<SlackDisconnectResult>
  isConnected: boolean
  isLoading: boolean
  login: () => Promise<SlackLoginResult>
  refreshWorkspaces: () => Promise<SlackWorkspaceInfo[]>
  workspaces: SlackWorkspaceInfo[]
}

export function useSlack(): UseSlackReturn {
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  const refreshWorkspaces = useCallback(async () => {
    const result = await electron.sync.slack.listWorkspaces()
    setWorkspaces(result.workspaces)
    return result.workspaces
  }, [electron])

  useEffect(() => {
    electron.sync.slack
      .status()
      .then((result) => {
        setWorkspaces(result.workspaces ?? [])
        setIsLoading(false)
      })
      .catch((err) => {
        console.error("[useSlack] Failed to check Slack status:", err)
        setIsLoading(false)
      })
  }, [electron])

  const login = useCallback(async () => {
    const result = await electron.sync.slack.login()
    if (result.success) await refreshWorkspaces()
    return result
  }, [electron, refreshWorkspaces])

  const disconnect = useCallback(
    async (teamId?: string) => {
      const result = await electron.sync.slack.disconnect(teamId)
      if (result.success) {
        setWorkspaces((prev) => (teamId ? prev.filter((ws) => ws.teamId !== teamId) : []))
      }
      return result
    },
    [electron]
  )

  return { disconnect, isConnected: workspaces.length > 0, isLoading, login, refreshWorkspaces, workspaces }
}

interface UseSignalReturn {
  isLoading: boolean
  isLoggedIn: boolean
  setup: (credentials?: SignalLoginCredentials) => Promise<SignalSetupResult>
  openLinkTerminal: (cliPath: string) => Promise<{ success: boolean; error?: string }>
  checkLink: (cliPath: string) => Promise<SignalLoginResult>
  logout: () => Promise<{ error?: string; success: boolean }>
  sendMessage: (threadOrRecipient: string, text: string) => Promise<SignalSendMessageResult>
}

export function useSignal(): UseSignalReturn {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  useEffect(() => {
    electron.sync.signal.status().then((result) => {
      setIsLoggedIn(result.isLoggedIn)
      setIsLoading(false)
    })
  }, [electron])

  const setup = useCallback(
    (credentials?: SignalLoginCredentials) => electron.sync.signal.setup(credentials),
    [electron]
  )

  const openLinkTerminal = useCallback(
    (cliPath: string) => electron.sync.signal.openLinkTerminal(cliPath),
    [electron]
  )

  const checkLink = useCallback(
    async (cliPath: string) => {
      const result = await electron.sync.signal.checkLink(cliPath)
      if (result.isLoggedIn) setIsLoggedIn(true)
      return result
    },
    [electron]
  )

  const logout = useCallback(async () => {
    const result = await electron.sync.signal.logout()
    if (result.success) setIsLoggedIn(false)
    return result
  }, [electron])

  const sendMessage = useCallback(
    (threadOrRecipient: string, text: string) =>
      electron.sync.signal.sendMessage(threadOrRecipient, text),
    [electron]
  )

  return { isLoading, isLoggedIn, setup, openLinkTerminal, checkLink, logout, sendMessage }
}

interface UseConvexClientReturn {
  convexUrl: string | null
  getAccessToken: () => Promise<string | null>
  isLoading: boolean
}

export function useConvexClient(): UseConvexClientReturn {
  const [convexUrl, setConvexUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const electron = useElectron()

  useEffect(() => {
    electron.config
      .getConvexUrl()
      .then((url) => {
        setConvexUrl(url)
      })
      .catch((error) => {
        console.error("[useConvexClient] Failed to get Convex URL:", error)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [electron])

  const getAccessToken = useCallback(() => electron.config.getAccessToken(), [electron])

  return { convexUrl, getAccessToken, isLoading }
}
