import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

WebBrowser.maybeCompleteAuthSession();

const ACCESS_TOKEN_KEY = "prm_access_token";
const REFRESH_TOKEN_KEY = "prm_refresh_token";
const USER_KEY = "prm_user";

const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID!;
const WORKOS_AUTH_ENDPOINT = "https://api.workos.com/user_management/authorize";
const WORKOS_TOKEN_ENDPOINT = "https://api.workos.com/user_management/authenticate";

const WORKOS_REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: "prm",
  path: "auth/callback",
});

if (__DEV__) {
  console.log("[PRM Auth] Redirect URI for WorkOS Dashboard:", WORKOS_REDIRECT_URI);
}

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

async function generateRandomString(length: number): Promise<string> {
  const randomBytes = await Crypto.getRandomBytesAsync(length);
  return Array.from(randomBytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
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
  const codeChallenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { codeVerifier, codeChallenge };
}

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

export async function signIn(provider: "GoogleOAuth" | "AppleOAuth"): Promise<AuthResult> {
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
  await setAccessToken(authResult.accessToken);
  await setRefreshToken(authResult.refreshToken);
  await setUser(authResult.user);

  return authResult;
}

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function setAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function getUser(): Promise<WorkOSUser | null> {
  const userData = await SecureStore.getItemAsync(USER_KEY);
  if (!userData) return null;
  try {
    return JSON.parse(userData);
  } catch {
    return null;
  }
}

export async function setUser(user: WorkOSUser): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getAccessToken();
  return token !== null;
}

export function getRedirectUri(): string {
  return WORKOS_REDIRECT_URI;
}
