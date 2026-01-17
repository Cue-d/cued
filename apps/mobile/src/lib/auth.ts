/**
 * WorkOS Authentication Helpers for React Native
 * Implements OAuth 2.0 with PKCE for secure mobile authentication
 */
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

// Complete the web browser auth session when app opens from redirect
WebBrowser.maybeCompleteAuthSession();

// Storage keys
const ACCESS_TOKEN_KEY = "prm_access_token";
const REFRESH_TOKEN_KEY = "prm_refresh_token";
const USER_KEY = "prm_user";

// WorkOS Configuration
const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID!;

// Generate redirect URI - this will be logged so you can add it to WorkOS Dashboard
const WORKOS_REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: "prm",
  path: "auth/callback",
});

// Log the redirect URI on module load - ADD THIS TO WORKOS DASHBOARD > REDIRECTS
console.log("=".repeat(60));
console.log("[PRM Auth] Add this redirect URI to WorkOS Dashboard:");
console.log(WORKOS_REDIRECT_URI);
console.log("=".repeat(60));

// WorkOS API endpoints
// Note: User Management API is for web apps with HTTPS redirects
// For mobile apps, WorkOS recommends using SSO with OAuth connections
// We're trying User Management first, but may need to switch to SSO
const WORKOS_AUTH_ENDPOINT = "https://api.workos.com/user_management/authorize";
const WORKOS_TOKEN_ENDPOINT =
  "https://api.workos.com/user_management/authenticate";

export interface WorkOSUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified: boolean;
  profilePictureUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: WorkOSUser;
  accessToken: string;
  refreshToken: string;
}

/**
 * Generate a cryptographically secure random string for PKCE
 */
async function generateRandomString(length: number): Promise<string> {
  const randomBytes = await Crypto.getRandomBytesAsync(length);
  return Array.from(randomBytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/**
 * Generate PKCE code verifier and challenge
 */
async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  // Generate a random code verifier (43-128 characters)
  const codeVerifier = await generateRandomString(64);

  // Create SHA-256 hash of the code verifier
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    codeVerifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );

  // Convert to URL-safe base64
  const codeChallenge = digest
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { codeVerifier, codeChallenge };
}

/**
 * Build the WorkOS authorization URL
 */
export function buildAuthorizationUrl(
  provider: "GoogleOAuth" | "AppleOAuth" | "authkit",
  codeChallenge: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: WORKOS_CLIENT_ID,
    redirect_uri: WORKOS_REDIRECT_URI,
    response_type: "code",
    provider,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return `${WORKOS_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<AuthResult> {
  const response = await fetch(WORKOS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: WORKOS_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json();
  return {
    user: data.user,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

/**
 * Initiate OAuth sign-in flow
 */
export async function signIn(
  provider: "GoogleOAuth" | "AppleOAuth"
): Promise<AuthResult> {
  // Generate PKCE challenge
  const { codeVerifier, codeChallenge } = await generatePKCE();

  // Generate random state for CSRF protection
  const state = await generateRandomString(32);

  // Build authorization URL
  const authUrl = buildAuthorizationUrl(provider, codeChallenge, state);

  // Open browser for authentication
  const result = await WebBrowser.openAuthSessionAsync(
    authUrl,
    WORKOS_REDIRECT_URI
  );

  if (result.type !== "success") {
    throw new Error(`Authentication cancelled or failed: ${result.type}`);
  }

  // Extract code from callback URL
  const url = new URL(result.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (!code) {
    throw new Error("No authorization code received");
  }

  // Verify state matches (CSRF protection)
  if (returnedState !== state) {
    throw new Error("State mismatch - possible CSRF attack");
  }

  // Exchange code for tokens
  const authResult = await exchangeCodeForTokens(code, codeVerifier);

  // Store tokens and user data
  await setAccessToken(authResult.accessToken);
  await setRefreshToken(authResult.refreshToken);
  await setUser(authResult.user);

  return authResult;
}

/**
 * Sign out and clear stored tokens
 */
export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

/**
 * Get access token from secure storage
 */
export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

/**
 * Set access token in secure storage
 */
export async function setAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token);
}

/**
 * Get refresh token from secure storage
 */
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/**
 * Set refresh token in secure storage
 */
export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/**
 * Get stored user data
 */
export async function getUser(): Promise<WorkOSUser | null> {
  const userData = await SecureStore.getItemAsync(USER_KEY);
  if (!userData) return null;
  try {
    return JSON.parse(userData);
  } catch {
    return null;
  }
}

/**
 * Set user data in secure storage
 */
export async function setUser(user: WorkOSUser): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

/**
 * Check if user is authenticated (has valid token)
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getAccessToken();
  return token !== null;
}

/**
 * Get the redirect URI (for displaying to user or debugging)
 */
export function getRedirectUri(): string {
  return WORKOS_REDIRECT_URI;
}
