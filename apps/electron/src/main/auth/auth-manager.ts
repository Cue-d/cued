// Auth Manager - coordinates device authorization and token lifecycle

import { deviceAuthorizationFlow, TokenResponse } from "./workos-device";
import {
  storeTokens,
  getStoredTokens,
  hasValidTokens,
  clearTokens,
  StoredTokens,
} from "./token-storage";

const REFRESH_ENDPOINT = "https://api.workos.com/user_management/authenticate";

export interface AuthState {
  isAuthenticated: boolean;
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export interface AuthCallbacks {
  onUserCode?: (code: string, uri: string) => void;
  onAuthSuccess?: (user: AuthState["user"]) => void;
  onAuthError?: (error: string) => void;
}

let currentClientId: string | null = null;

/** Callback when tokens are refreshed */
let onTokenRefreshedCallback: ((state: AuthState) => void) | null = null;

/**
 * Initialize the auth manager with WorkOS client ID.
 */
export function initAuth(clientId: string): void {
  currentClientId = clientId;
}

/**
 * Set callback to be called when tokens are refreshed.
 * Useful for notifying the UI when auth state is restored.
 */
export function setOnTokenRefreshed(callback: (state: AuthState) => void): void {
  onTokenRefreshedCallback = callback;
}

const UNAUTHENTICATED_STATE: AuthState = { isAuthenticated: false, user: null };

/**
 * Get the current auth state.
 */
export function getAuthState(): AuthState {
  const tokens = getStoredTokens();
  if (!tokens || !hasValidTokens()) {
    return UNAUTHENTICATED_STATE;
  }

  return {
    isAuthenticated: true,
    user: {
      id: tokens.userId,
      email: tokens.email,
      firstName: tokens.firstName,
      lastName: tokens.lastName,
    },
  };
}

// Track last successful refresh to avoid rapid retry loops
let lastRefreshTime = 0;
const MIN_REFRESH_INTERVAL_MS = 5000; // Don't refresh more than once per 5 seconds

/**
 * Get a valid access token, refreshing if necessary.
 * Implements proactive token refresh with 5 minute buffer.
 * @param forceRefresh - If true, always refresh the token regardless of expiry
 */
export async function getValidAccessToken(
  forceRefresh = false
): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens) {
    return null;
  }

  // Check if access token is still valid (with 5 min buffer)
  const bufferMs = 5 * 60 * 1000;
  const timeUntilExpiry = tokens.expiresAt - Date.now();

  if (!forceRefresh && timeUntilExpiry > bufferMs) {
    // Token is still valid
    return tokens.accessToken;
  }

  // Rate limit refresh attempts
  const timeSinceLastRefresh = Date.now() - lastRefreshTime;
  if (timeSinceLastRefresh < MIN_REFRESH_INTERVAL_MS) {
    console.log(`[Auth] Skipping refresh, last refresh was ${timeSinceLastRefresh}ms ago`);
    return tokens.accessToken; // Return current token, let caller handle error
  }

  console.log(`[Auth] Token needs refresh: expires in ${Math.round(timeUntilExpiry / 1000)}s (buffer: ${bufferMs / 1000}s)`);

  if (tokens.refreshToken) {
    try {
      console.log("[Auth] Token expired or expiring, attempting refresh...");
      lastRefreshTime = Date.now();
      const newTokens = await refreshAccessToken(tokens.refreshToken);
      console.log("[Auth] Token refreshed successfully");
      return newTokens.accessToken;
    } catch (error) {
      // Refresh failed, user needs to re-authenticate
      console.error("[Auth] Token refresh failed:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  return null;
}

/**
 * Check if an error is an auth/token error from Convex.
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("invalidauthheader") ||
      message.includes("token expired") ||
      message.includes("could not validate token") ||
      message.includes("unauthorized") ||
      message.includes("unauthenticated")
    );
  }
  if (typeof error === "string") {
    const lower = error.toLowerCase();
    return (
      lower.includes("invalidauthheader") ||
      lower.includes("token expired") ||
      lower.includes("could not validate token")
    );
  }
  return false;
}

/**
 * Force refresh the token immediately, regardless of expiry time.
 * Use this when you receive an auth error from the server.
 */
export async function forceRefreshToken(): Promise<string | null> {
  console.log("[Auth] Force refreshing token due to auth error...");
  return getValidAccessToken(true);
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  if (!currentClientId) {
    throw new Error("Auth not initialized");
  }

  const response = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: currentClientId,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      error.error_description || error.error || "Token refresh failed"
    );
  }

  const data = (await response.json()) as TokenResponse;
  const storedTokens = tokenResponseToStoredTokens(data);
  storeTokens(storedTokens);

  // Notify UI that auth is restored
  if (onTokenRefreshedCallback) {
    onTokenRefreshedCallback({
      isAuthenticated: true,
      user: {
        id: storedTokens.userId,
        email: storedTokens.email,
        firstName: storedTokens.firstName,
        lastName: storedTokens.lastName,
      },
    });
  }

  return storedTokens;
}

/**
 * Start the device authorization flow.
 * Opens browser for user to authenticate.
 */
export async function startDeviceAuth(
  callbacks?: AuthCallbacks
): Promise<void> {
  if (!currentClientId) {
    throw new Error("Auth not initialized. Call initAuth(clientId) first.");
  }

  try {
    const tokens = await deviceAuthorizationFlow(currentClientId, {
      onUserCode: callbacks?.onUserCode,
    });

    const storedTokens = tokenResponseToStoredTokens(tokens);
    storeTokens(storedTokens);

    if (callbacks?.onAuthSuccess) {
      callbacks.onAuthSuccess({
        id: storedTokens.userId,
        email: storedTokens.email,
        firstName: storedTokens.firstName,
        lastName: storedTokens.lastName,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed";
    if (callbacks?.onAuthError) {
      callbacks.onAuthError(message);
    }
    throw error;
  }
}

/**
 * Sign out and clear stored tokens.
 */
export function signOut(): void {
  clearTokens();
}

/**
 * Convert WorkOS token response to storage format.
 */
function tokenResponseToStoredTokens(response: TokenResponse): StoredTokens {
  // Default to 1 hour if expires_in not provided (WorkOS doesn't always include it)
  const expiresIn = response.expires_in || 3600;

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    userId: response.user.id,
    email: response.user.email,
    firstName: response.user.first_name,
    lastName: response.user.last_name,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}
