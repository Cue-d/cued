/**
 * Mock window.electron API for browser-based UI debugging.
 * Only loaded in development when running outside Electron (e.g., Chrome).
 *
 * This allows the renderer to boot and render the authenticated UI
 * using the real Convex backend. Sync operations are no-ops.
 */

import type { ElectronAPI } from "../shared/electron-api"

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined

// Check if we're already in Electron (preload script sets window.electron)
// Only activate in development — never silently mock in production builds
if (!window.electron && import.meta.env.DEV) {
  console.warn("[browser-mock] Electron API not found — injecting browser mock for UI debugging")

  if (!CONVEX_URL) {
    console.warn("[browser-mock] VITE_CONVEX_URL not set — mock Convex client will not connect")
  }

  const noop = () => () => {}

  const mock: ElectronAPI = {
    settings: {
      getSyncHistoryDays: async () => 90,
      setSyncHistoryDays: async (days: number) => days,
    },

    versions: {
      node: () => "mock",
      chrome: () => navigator.userAgent,
      electron: () => "browser-mock",
    },

    config: {
      getConvexUrl: async () => CONVEX_URL ?? "",
      getAccessToken: async (_forceRefresh?: boolean) => localStorage.getItem("__cued_dev_token"),
      getAppUrl: async () => "http://localhost:3000",
    },

    shell: {
      openExternal: async (url: string) => {
        window.open(url, "_blank")
        return true
      },
    },

    auth: {
      getState: async () => {
        const token = localStorage.getItem("__cued_dev_token")
        if (token) {
          return {
            isAuthenticated: true,
            user: {
              id: "browser-dev",
              email: "dev@localhost",
              firstName: "Dev",
              lastName: "User",
            },
          }
        }
        return { isAuthenticated: false, user: null }
      },
      startLogin: async () => {
        const token = prompt("Paste a valid Convex auth token (from Electron devtools or web app):")
        if (token) {
          localStorage.setItem("__cued_dev_token", token)
          window.location.reload()
        }
      },
      signOut: async () => {
        localStorage.removeItem("__cued_dev_token")
        window.location.reload()
      },
      onAuthChange: () => noop(),
      onUserCode: () => noop(),
    },

    updater: {
      onStatus: () => noop(),
      quitAndInstall: async () => {},
    },

    permissions: {
      check: async () => ({ fullDiskAccess: false, contacts: false }),
      openFullDiskAccessSettings: async () => {},
      openContactsSettings: async () => {},
    },

    sync: {
      runAll: async () => ({ success: true, platforms: {} }),
      runNow: async () => ({ success: true, platforms: {} }),
      getProgress: async () => ({ status: "idle", platforms: {} }),
      onProgress: () => noop(),

      linkedin: {
        status: async () => ({ isLoggedIn: false }),
        login: async () => ({ isLoggedIn: false }),
        logout: async () => ({ success: true }),
        sendMessage: async () => ({ success: false, error: "Browser mock" }),
        getProgress: async () => ({
          status: "idle",
          realtimeConnected: false,
          totalConversationsSynced: 0,
          totalMessagesSynced: 0,
        }),
      },

      twitter: {
        status: async () => ({ isLoggedIn: false }),
        login: async () => ({ isLoggedIn: false }),
        logout: async () => ({ success: true }),
        sendMessage: async () => ({ success: false, error: "Browser mock" }),
        getProgress: async () => ({
          status: "idle",
          totalConversationsSynced: 0,
          totalMessagesSynced: 0,
          totalContactsSynced: 0,
        }),
      },

      slack: {
        status: async () => ({ isConnected: false }),
        login: async () => ({ success: false, error: "Browser mock" }),
        disconnect: async () => ({ success: true }),
        listWorkspaces: async () => ({ workspaces: [] }),
        getProgress: async () => ({
          status: "idle",
          totalConversationsSynced: 0,
          totalMessagesSynced: 0,
        }),
      },

      signal: {
        status: async () => ({ isLoggedIn: false }),
        setup: async () => ({ success: false, steps: [], error: "Browser mock" }),
        openLinkTerminal: async () => ({ success: false, error: "Browser mock" }),
        checkLink: async () => ({ success: false, isLoggedIn: false }),
        logout: async () => ({ success: true }),
        sendMessage: async () => ({ success: false, error: "Browser mock" }),
        getProgress: async () => ({
          status: "idle",
          totalMessagesSynced: 0,
        }),
      },
    },
  }

  ;(window as any).electron = mock
}
