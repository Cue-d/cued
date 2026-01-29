import { useState, useEffect, useCallback } from "react";

// ============================================================================
// Auth Types
// ============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
}

// ============================================================================
// Unified Sync Types
// ============================================================================

export interface PlatformSyncResult {
  contacts?: { synced: number; updated: number };
  linkedin?: { contacts: number; messages: number };
  slack?: { messages: number; workspaces: number };
  imessage?: { messages: number };
}

export interface UnifiedSyncProgress {
  status: "idle" | "syncing" | "error";
  currentPlatform?: "contacts" | "linkedin" | "slack" | "imessage";
  lastSyncAt?: number;
  platforms: PlatformSyncResult;
  error?: string;
}

export interface UnifiedSyncResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  platforms: PlatformSyncResult;
}

// ============================================================================
// LinkedIn Types
// ============================================================================

export interface LinkedInStatusResult {
  isLoggedIn: boolean;
  error?: string;
}

export interface LinkedInSyncProgress {
  status: "idle" | "syncing" | "realtime" | "error";
  totalConversationsSynced: number;
  totalMessagesSynced: number;
  realtimeConnected: boolean;
  lastSyncAt?: number;
  error?: string;
}

export interface LinkedInSendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ============================================================================
// Slack Types
// ============================================================================

export interface SlackSyncProgress {
  status: "idle" | "syncing" | "error";
  totalConversationsSynced: number;
  totalMessagesSynced: number;
  lastSyncAt?: number;
  teamName?: string;
  teamId?: string;
  error?: string;
}

export interface SlackWorkspaceInfo {
  teamId: string;
  teamName: string;
  userId: string;
  isConnected: boolean;
  syncProgress?: SlackSyncProgress;
}

export interface SlackStatusResult {
  isConnected: boolean;
  teamName?: string;
  workspaces?: SlackWorkspaceInfo[];
  error?: string;
}

export interface SlackLoginResult {
  success: boolean;
  teamId?: string;
  teamName?: string;
  error?: string;
}

export interface SlackDisconnectResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Window Type Declaration
// ============================================================================

declare global {
  interface Window {
    electron: {
      versions: {
        node: () => string;
        chrome: () => string;
        electron: () => string;
      };
      auth: {
        getState: () => Promise<AuthState>;
        startLogin: () => Promise<void>;
        signOut: () => Promise<void>;
        onAuthChange: (callback: (state: AuthState) => void) => () => void;
        onUserCode: (callback: (code: string, uri: string) => void) => () => void;
      };
      sync: {
        // Unified sync
        runAll: () => Promise<UnifiedSyncResult>;
        runNow: () => Promise<UnifiedSyncResult>;
        getProgress: () => Promise<UnifiedSyncProgress>;
        onProgress: (callback: (progress: UnifiedSyncProgress) => void) => () => void;
        // LinkedIn (login/status only)
        linkedin: {
          status: () => Promise<LinkedInStatusResult>;
          login: () => Promise<LinkedInStatusResult>;
          logout: () => Promise<{ success: boolean; error?: string }>;
          sendMessage: (conversationId: string, text: string) => Promise<LinkedInSendMessageResult>;
          getProgress: () => Promise<LinkedInSyncProgress>;
        };
        // Slack (login/status/disconnect only)
        slack: {
          status: () => Promise<SlackStatusResult>;
          login: () => Promise<SlackLoginResult>;
          disconnect: (teamId?: string) => Promise<SlackDisconnectResult>;
          listWorkspaces: () => Promise<{ workspaces: SlackWorkspaceInfo[] }>;
          getProgress: () => Promise<SlackSyncProgress>;
        };
      };
    };
  }
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access the Electron API
 */
export function useElectron() {
  if (!window.electron) {
    throw new Error(
      "Electron API not available - preload script may have failed to load"
    );
  }
  return window.electron;
}

/**
 * Hook to manage auth state
 */
export function useAuthState() {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [userCode, setUserCode] = useState<string | null>(null);
  const electron = useElectron();

  useEffect(() => {
    // Get initial auth state
    electron.auth.getState().then((s) => {
      setState(s);
      setIsLoading(false);
    });

    // Subscribe to auth changes
    const unsubAuth = electron.auth.onAuthChange((s) => {
      setState(s);
      setUserCode(null); // Clear user code when auth changes
    });

    // Subscribe to user code display
    const unsubCode = electron.auth.onUserCode((code) => {
      setUserCode(code);
    });

    return () => {
      unsubAuth();
      unsubCode();
    };
  }, [electron]);

  const login = useCallback(async () => {
    await electron.auth.startLogin();
  }, [electron]);

  const signOut = useCallback(async () => {
    await electron.auth.signOut();
  }, [electron]);

  return { ...state, isLoading, userCode, login, signOut };
}

/**
 * Hook to manage unified sync
 */
export function useUnifiedSync() {
  const [progress, setProgress] = useState<UnifiedSyncProgress>({
    status: "idle",
    platforms: {},
  });
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  useEffect(() => {
    // Get initial progress
    electron.sync.getProgress().then((p) => {
      setProgress(p);
      setIsLoading(false);
    });

    // Subscribe to progress updates
    const unsub = electron.sync.onProgress(setProgress);
    return unsub;
  }, [electron]);

  const runNow = useCallback(async () => {
    const result = await electron.sync.runNow();
    return result;
  }, [electron]);

  const runAll = useCallback(async () => {
    const result = await electron.sync.runAll();
    return result;
  }, [electron]);

  return {
    progress,
    isLoading,
    isSyncing: progress.status === "syncing",
    lastSyncAt: progress.lastSyncAt,
    currentPlatform: progress.currentPlatform,
    platforms: progress.platforms,
    error: progress.error,
    runNow,
    runAll,
  };
}

/**
 * Hook to manage LinkedIn connection (login/status only, sync handled by unified sync)
 */
export function useLinkedIn() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  useEffect(() => {
    // Check initial status
    electron.sync.linkedin.status().then((result) => {
      setIsLoggedIn(result.isLoggedIn);
      setIsLoading(false);
    });
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.sync.linkedin.login();
    setIsLoggedIn(result.isLoggedIn);
    return result;
  }, [electron]);

  const logout = useCallback(async () => {
    const result = await electron.sync.linkedin.logout();
    if (result.success) {
      setIsLoggedIn(false);
    }
    return result;
  }, [electron]);

  const sendMessage = useCallback(
    async (conversationId: string, text: string) => {
      return await electron.sync.linkedin.sendMessage(conversationId, text);
    },
    [electron]
  );

  return {
    isLoggedIn,
    isLoading,
    login,
    logout,
    sendMessage,
  };
}

/**
 * Hook to manage Slack connection (login/status/disconnect only, sync handled by unified sync)
 */
export function useSlack() {
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  const isConnected = workspaces.length > 0;

  const refreshWorkspaces = useCallback(async () => {
    const result = await electron.sync.slack.listWorkspaces();
    setWorkspaces(result.workspaces);
    return result.workspaces;
  }, [electron]);

  useEffect(() => {
    // Check initial status and load workspaces
    electron.sync.slack
      .status()
      .then((result) => {
        setWorkspaces(result.workspaces ?? []);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("[useSlack] Failed to check Slack status:", err);
        setIsLoading(false);
      });
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.sync.slack.login();
    if (result.success) {
      await refreshWorkspaces();
    }
    return result;
  }, [electron, refreshWorkspaces]);

  const disconnect = useCallback(
    async (teamId?: string) => {
      const result = await electron.sync.slack.disconnect(teamId);
      if (result.success) {
        if (teamId) {
          setWorkspaces((prev) => prev.filter((ws) => ws.teamId !== teamId));
        } else {
          setWorkspaces([]);
        }
      }
      return result;
    },
    [electron]
  );

  return {
    isConnected,
    workspaces,
    isLoading,
    login,
    disconnect,
    refreshWorkspaces,
  };
}

// ============================================================================
// Deprecated Hooks (for backwards compatibility)
// ============================================================================

/**
 * @deprecated Use useUnifiedSync instead
 */
export function useSyncProgress() {
  const { progress, runNow } = useUnifiedSync();
  return {
    progress: {
      status: progress.status,
      totalMessagesSynced: progress.platforms.imessage?.messages ?? 0,
      lastSyncAt: progress.lastSyncAt,
    },
    forceSync: runNow,
  };
}

/**
 * @deprecated Use useUnifiedSync instead
 */
export function useIMessageSync() {
  const { progress, runNow } = useUnifiedSync();
  return {
    progress: {
      status: progress.status,
      totalMessagesSynced: progress.platforms.imessage?.messages ?? 0,
      lastSyncAt: progress.lastSyncAt,
    },
    runNow,
    reset: async () => {
      console.warn("reset() is deprecated - use unified sync instead");
    },
    forceFullSync: runNow,
  };
}
