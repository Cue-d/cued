import * as AuthSession from "expo-auth-session";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { clientEnv } from "@cued/env/client";

WebBrowser.maybeCompleteAuthSession();

const STORAGE_KEYS = {
  accessToken: "cued_access_token",
  refreshToken: "cued_refresh_token",
  user: "cued_user",
} as const;

const WORKOS_CLIENT_ID = clientEnv.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? "";
const WORKOS_AUTH_ENDPOINT = "https://api.workos.com/user_management/authorize";
const WORKOS_TOKEN_ENDPOINT = "https://api.workos.com/user_management/authenticate";

const WORKOS_REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: "cued",
  path: "auth/callback",
});

if (__DEV__) {
  console.log("[Cued Auth] Redirect URI:", WORKOS_REDIRECT_URI);
}

export type OAuthProvider = "GoogleOAuth" | "AppleOAuth";


export interface WorkOSUser {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  email_verified: boolean;
  profile_picture_url?: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResult {
  user: WorkOSUser;
  accessToken: string;
  refreshToken: string;
}

async function generateRandomString(length: number): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(length);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = await generateRandomString(64);
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    codeVerifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  const codeChallenge = digest
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { codeVerifier, codeChallenge };
}

function buildAuthorizationUrl(
  provider: OAuthProvider,
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

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<AuthResult> {
  const response = await fetch(WORKOS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: WORKOS_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    user: data.user,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

/**
 * Refresh the access token using the stored refresh token.
 * Returns the new auth result, or null if refresh failed.
 */
export async function refreshAccessToken(): Promise<AuthResult | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    if (__DEV__) {
      console.log("[Cued Auth] No refresh token available");
    }
    return null;
  }

  try {
    const response = await fetch(WORKOS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: WORKOS_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (__DEV__) {
        console.log("[Cued Auth] Token refresh failed:", errorText);
      }
      // Clear invalid tokens
      await signOut();
      return null;
    }

    const data = await response.json();
    const authResult: AuthResult = {
      user: data.user,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };

    // Store the new tokens
    await Promise.all([
      setAccessToken(authResult.accessToken),
      setRefreshToken(authResult.refreshToken),
      setUser(authResult.user),
    ]);

    if (__DEV__) {
      console.log("[Cued Auth] Token refreshed successfully");
    }

    return authResult;
  } catch (error) {
    if (__DEV__) {
      console.error("[Cued Auth] Token refresh error:", error);
    }
    return null;
  }
}

export async function signIn(provider: OAuthProvider): Promise<AuthResult> {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = await generateRandomString(32);
  const authUrl = buildAuthorizationUrl(provider, codeChallenge, state);

  const result = await WebBrowser.openAuthSessionAsync(authUrl, WORKOS_REDIRECT_URI);
  if (result.type !== "success") {
    throw new Error(`Authentication cancelled or failed: ${result.type}`);
  }

  const url = new URL(result.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (!code) {
    throw new Error("No authorization code received");
  }
  if (returnedState !== state) {
    throw new Error("State mismatch - possible CSRF attack");
  }

  const authResult = await exchangeCodeForTokens(code, codeVerifier);
  await Promise.all([
    setAccessToken(authResult.accessToken),
    setRefreshToken(authResult.refreshToken),
    setUser(authResult.user),
  ]);

  return authResult;
}

export async function signOut(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.accessToken),
    SecureStore.deleteItemAsync(STORAGE_KEYS.refreshToken),
    SecureStore.deleteItemAsync(STORAGE_KEYS.user),
  ]);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.accessToken);
}

export async function setAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.accessToken, token);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.refreshToken);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.refreshToken, token);
}

export async function getUser(): Promise<WorkOSUser | null> {
  const userData = await SecureStore.getItemAsync(STORAGE_KEYS.user);
  if (!userData) return null;
  try {
    return JSON.parse(userData);
  } catch {
    return null;
  }
}

export async function setUser(user: WorkOSUser): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.user, JSON.stringify(user));
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getAccessToken();
  return token !== null;
}

export function getRedirectUri(): string {
  return WORKOS_REDIRECT_URI;
}
