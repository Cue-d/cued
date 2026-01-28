import { useState, useEffect, useCallback } from "react";

// Types for Electron IPC API
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
}

export interface SyncProgress {
  status: "idle" | "syncing" | "error" | "recovery";
  lastSyncAt?: number;
  lastCursor?: number;
  totalMessagesSynced: number;
  totalContactsSynced?: number;
  currentBatch?: {
    messagesInBatch: number;
    batchNumber: number;
    estimatedBatchesRemaining: number;
  };
  error?: string;
  recoveryReason?: string;
}

export interface SocialStatusResult {
  isLoggedIn: boolean;
  error?: string;
}

export interface SocialScrapeResult {
  success: boolean;
  data?: unknown[];
  error?: string;
  count?: number;
}

export interface SocialProgress {
  status: "starting" | "complete" | "error";
  count?: number;
  type?: string;
  error?: string;
}

export interface LinkedInMessagingStatus {
  connected: boolean;
  syncProgress?: LinkedInSyncProgress;
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

export interface LinkedInSyncResult {
  success: boolean;
  error?: string;
}

// Slack types (Native integration - Task 5.1) - Multi-workspace support
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

export interface SlackSyncProgress {
  status: "idle" | "syncing" | "error";
  totalConversationsSynced: number;
  totalMessagesSynced: number;
  lastSyncAt?: number;
  teamName?: string;
  teamId?: string;
  error?: string;
}

export interface SlackMessagingStatus {
  connected: boolean;
  syncProgress?: SlackSyncProgress;
  workspaces?: SlackWorkspaceInfo[];
  error?: string;
}

export interface SlackSyncResult {
  success: boolean;
  error?: string;
}

export interface SlackListWorkspacesResult {
  workspaces: SlackWorkspaceInfo[];
}

// Global type declaration for the unified sync API
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
        // iMessage sync
        imessage: {
          getProgress: () => Promise<SyncProgress>;
          runNow: () => Promise<SyncProgress>;
          reset: () => Promise<SyncProgress>;
          forceFullSync: () => Promise<SyncProgress>;
          onProgress: (callback: (progress: SyncProgress) => void) => () => void;
        };
        // LinkedIn sync
        linkedin: {
          status: () => Promise<SocialStatusResult>;
          login: () => Promise<SocialStatusResult>;
          scrape: (options?: { maxConnections?: number }) => Promise<SocialScrapeResult>;
          messagingStatus: () => Promise<LinkedInMessagingStatus>;
          start: () => Promise<LinkedInSyncResult>;
          stop: () => Promise<LinkedInSyncResult>;
          sendMessage: (conversationId: string, text: string) => Promise<unknown>;
          getProgress: () => Promise<LinkedInSyncProgress>;
          onProgress: (callback: (progress: LinkedInSyncProgress) => void) => () => void;
          onScrapeProgress: (callback: (progress: SocialProgress) => void) => () => void;
          onAuthInvalid: (callback: () => void) => () => void;
        };
        // Slack sync
        slack: {
          status: () => Promise<SlackStatusResult>;
          login: () => Promise<SlackLoginResult>;
          disconnect: (teamId?: string) => Promise<SlackSyncResult>;
          listWorkspaces: () => Promise<SlackListWorkspacesResult>;
          messagingStatus: () => Promise<SlackMessagingStatus>;
          start: (teamId?: string) => Promise<SlackSyncResult>;
          stop: (teamId?: string) => Promise<SlackSyncResult>;
          getProgress: () => Promise<SlackSyncProgress>;
          onProgress: (callback: (progress: SlackSyncProgress) => void) => () => void;
          onAuthInvalid: (callback: () => void) => () => void;
        };
      };
    };
  }
}

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
 * Hook to manage iMessage sync progress
 */
export function useIMessageSync() {
  const [progress, setProgress] = useState<SyncProgress>({
    status: "idle",
    totalMessagesSynced: 0,
  });
  const electron = useElectron();

  useEffect(() => {
    // Get initial sync progress
    electron.sync.imessage.getProgress().then(setProgress);

    // Subscribe to progress updates
    const unsub = electron.sync.imessage.onProgress(setProgress);
    return unsub;
  }, [electron]);

  const runNow = useCallback(async () => {
    const result = await electron.sync.imessage.runNow();
    setProgress(result);
    return result;
  }, [electron]);

  const reset = useCallback(async () => {
    const result = await electron.sync.imessage.reset();
    setProgress(result);
    return result;
  }, [electron]);

  const forceFullSync = useCallback(async () => {
    const result = await electron.sync.imessage.forceFullSync();
    setProgress(result);
    return result;
  }, [electron]);

  return { progress, runNow, reset, forceFullSync };
}

/**
 * Hook to manage sync progress (alias for backwards compatibility)
 * @deprecated Use useIMessageSync instead
 */
export function useSyncProgress() {
  const { progress, forceFullSync } = useIMessageSync();
  return { progress, forceSync: forceFullSync };
}

/**
 * Hook to manage LinkedIn status and sync
 */
export function useLinkedIn() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [syncProgress, setSyncProgress] = useState<LinkedInSyncProgress | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  useEffect(() => {
    // Check initial status
    electron.sync.linkedin.status().then((result) => {
      setIsLoggedIn(result.isLoggedIn);
      setIsLoading(false);

      if (result.isLoggedIn) {
        electron.sync.linkedin.messagingStatus().then((status) => {
          if (status.syncProgress) {
            setSyncProgress(status.syncProgress);
          }
        });
      }
    });

    // Subscribe to messaging sync progress
    const unsubProgress = electron.sync.linkedin.onProgress(setSyncProgress);

    // Subscribe to auth invalid
    const unsubAuth = electron.sync.linkedin.onAuthInvalid(() => {
      setIsLoggedIn(false);
      setSyncProgress(null);
    });

    return () => {
      unsubProgress();
      unsubAuth();
    };
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.sync.linkedin.login();
    setIsLoggedIn(result.isLoggedIn);
    return result;
  }, [electron]);

  const startSync = useCallback(async () => {
    return await electron.sync.linkedin.start();
  }, [electron]);

  const stopSync = useCallback(async () => {
    return await electron.sync.linkedin.stop();
  }, [electron]);

  const scrape = useCallback(
    async (options?: { maxConnections?: number }) => {
      return await electron.sync.linkedin.scrape(options);
    },
    [electron]
  );

  return {
    isLoggedIn,
    isLoading,
    syncProgress,
    login,
    startSync,
    stopSync,
    scrape,
  };
}

/**
 * Hook to manage Slack native integration - Multi-workspace support
 */
export function useSlack() {
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceInfo[]>([]);
  const [syncProgress, setSyncProgress] = useState<SlackSyncProgress | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  // Derived state
  const isConnected = workspaces.length > 0;

  // Refresh workspaces list
  const refreshWorkspaces = useCallback(async () => {
    const result = await electron.sync.slack.listWorkspaces();
    setWorkspaces(result.workspaces);
    return result.workspaces;
  }, [electron]);

  useEffect(() => {
    // Check initial status and load workspaces
    electron.sync.slack.status().then((result) => {
      setWorkspaces(result.workspaces ?? []);
      setIsLoading(false);

      if (result.isConnected) {
        electron.sync.slack.messagingStatus().then((status) => {
          if (status.syncProgress) {
            setSyncProgress(status.syncProgress);
          }
        }).catch((err) => {
          console.error('[useSlack] Failed to get messaging status:', err);
        });
      }
    }).catch((err) => {
      console.error('[useSlack] Failed to check Slack status:', err);
      setIsLoading(false);
    });

    // Subscribe to messaging sync progress
    const unsubProgress = electron.sync.slack.onProgress((progress) => {
      setSyncProgress(progress);
      // Update workspace sync progress
      if (progress.teamId) {
        setWorkspaces((prev) =>
          prev.map((ws) =>
            ws.teamId === progress.teamId
              ? { ...ws, syncProgress: progress }
              : ws
          )
        );
      }
    });

    // Subscribe to auth invalid
    const unsubAuth = electron.sync.slack.onAuthInvalid(() => {
      setWorkspaces([]);
      setSyncProgress(null);
    });

    return () => {
      unsubProgress();
      unsubAuth();
    };
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.sync.slack.login();
    if (result.success) {
      // Refresh workspaces to get complete data including userId
      await refreshWorkspaces();
    }
    return result;
  }, [electron, refreshWorkspaces]);

  const disconnect = useCallback(
    async (teamId?: string) => {
      const result = await electron.sync.slack.disconnect(teamId);
      if (result.success) {
        if (teamId) {
          // Remove specific workspace
          setWorkspaces((prev) => prev.filter((ws) => ws.teamId !== teamId));
        } else {
          // Remove all workspaces
          setWorkspaces([]);
        }
        setSyncProgress(null);
      }
      return result;
    },
    [electron]
  );

  const startSync = useCallback(
    async (teamId?: string) => {
      return await electron.sync.slack.start(teamId);
    },
    [electron]
  );

  const stopSync = useCallback(
    async (teamId?: string) => {
      return await electron.sync.slack.stop(teamId);
    },
    [electron]
  );

  return {
    isConnected,
    workspaces,
    isLoading,
    syncProgress,
    login,
    disconnect,
    startSync,
    stopSync,
    refreshWorkspaces,
  };
}
