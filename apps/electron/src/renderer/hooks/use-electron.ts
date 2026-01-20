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

// Global type declaration
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
        getProgress: () => Promise<SyncProgress>;
        runNow: () => Promise<SyncProgress>;
        reset: () => Promise<SyncProgress>;
        forceFullSync: () => Promise<SyncProgress>;
        onProgress: (callback: (progress: SyncProgress) => void) => () => void;
      };
      social: {
        linkedinStatus: () => Promise<SocialStatusResult>;
        linkedinLogin: () => Promise<SocialStatusResult>;
        linkedinScrape: (options?: {
          maxConnections?: number;
        }) => Promise<SocialScrapeResult>;
        linkedinMessagingStatus: () => Promise<LinkedInMessagingStatus>;
        linkedinStartMessagingSync: () => Promise<LinkedInSyncResult>;
        linkedinStopMessagingSync: () => Promise<LinkedInSyncResult>;
        linkedinSendMessage: (
          conversationId: string,
          text: string
        ) => Promise<unknown>;
        linkedinGetSyncProgress: () => Promise<LinkedInSyncProgress>;
        twitterStatus: () => Promise<SocialStatusResult>;
        twitterLogin: () => Promise<SocialStatusResult>;
        twitterScrapeMutuals: (
          username: string,
          options?: { maxUsers?: number }
        ) => Promise<SocialScrapeResult>;
        onLinkedinProgress: (
          callback: (progress: SocialProgress) => void
        ) => () => void;
        onLinkedinMessagingSyncProgress: (
          callback: (progress: LinkedInSyncProgress) => void
        ) => () => void;
        onLinkedinAuthInvalid: (callback: () => void) => () => void;
        onTwitterProgress: (
          callback: (progress: SocialProgress) => void
        ) => () => void;
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
 * Hook to manage sync progress
 */
export function useSyncProgress() {
  const [progress, setProgress] = useState<SyncProgress>({
    status: "idle",
    totalMessagesSynced: 0,
  });
  const electron = useElectron();

  useEffect(() => {
    // Get initial sync progress
    electron.sync.getProgress().then(setProgress);

    // Subscribe to progress updates
    const unsub = electron.sync.onProgress(setProgress);
    return unsub;
  }, [electron]);

  const forceSync = useCallback(async () => {
    const result = await electron.sync.forceFullSync();
    setProgress(result);
    return result;
  }, [electron]);

  return { progress, forceSync };
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
    electron.social.linkedinStatus().then((result) => {
      setIsLoggedIn(result.isLoggedIn);
      setIsLoading(false);

      if (result.isLoggedIn) {
        electron.social.linkedinMessagingStatus().then((status) => {
          if (status.syncProgress) {
            setSyncProgress(status.syncProgress);
          }
        });
      }
    });

    // Subscribe to messaging sync progress
    const unsubProgress = electron.social.onLinkedinMessagingSyncProgress(
      setSyncProgress
    );

    // Subscribe to auth invalid
    const unsubAuth = electron.social.onLinkedinAuthInvalid(() => {
      setIsLoggedIn(false);
      setSyncProgress(null);
    });

    return () => {
      unsubProgress();
      unsubAuth();
    };
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.social.linkedinLogin();
    setIsLoggedIn(result.isLoggedIn);
    return result;
  }, [electron]);

  const startSync = useCallback(async () => {
    return await electron.social.linkedinStartMessagingSync();
  }, [electron]);

  const stopSync = useCallback(async () => {
    return await electron.social.linkedinStopMessagingSync();
  }, [electron]);

  const scrape = useCallback(
    async (options?: { maxConnections?: number }) => {
      return await electron.social.linkedinScrape(options);
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
 * Hook to manage Twitter status
 */
export function useTwitter() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const electron = useElectron();

  useEffect(() => {
    electron.social.twitterStatus().then((result) => {
      setIsLoggedIn(result.isLoggedIn);
      setIsLoading(false);
    });
  }, [electron]);

  const login = useCallback(async () => {
    const result = await electron.social.twitterLogin();
    setIsLoggedIn(result.isLoggedIn);
    return result;
  }, [electron]);

  const scrapeMutuals = useCallback(
    async (username: string, options?: { maxUsers?: number }) => {
      return await electron.social.twitterScrapeMutuals(username, options);
    },
    [electron]
  );

  return { isLoggedIn, isLoading, login, scrapeMutuals };
}
