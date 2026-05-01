import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cuedAuthKeychainService } from "../../../core/identity.js";

export const GMAIL_KEYCHAIN_SERVICE = cuedAuthKeychainService("gmail");
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_OAUTH_CLIENT_RESOURCE_PATH =
  "Contents/Resources/oauth/google-oauth-client.json";

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

export interface GmailTokenPayload {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface StoredGmailCredentials {
  clientId?: string;
  clientSecret?: string;
  oauthClientFile?: string;
  tokenUri: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  emailAddress: string;
  historyId?: string | null;
  messagesTotal?: number | null;
  threadsTotal?: number | null;
}

function resolveBundledGoogleOAuthClientFile(): string | null {
  const explicit = process.env.CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE;
  if (explicit) return explicit;

  const appPath = process.env.CUED_APP_PATH;
  if (appPath) {
    const bundledPath = join(appPath, GOOGLE_OAUTH_CLIENT_RESOURCE_PATH);
    if (existsSync(bundledPath)) return bundledPath;
  }

  const runtimeRoot = process.env.CUED_BUNDLED_RUNTIME_ROOT;
  if (runtimeRoot) {
    const bundledPath = join(runtimeRoot, "..", "oauth", "google-oauth-client.json");
    if (existsSync(bundledPath)) return bundledPath;
  }

  return null;
}

export function resolveGoogleOAuthClientFile(): string {
  const explicit =
    process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE ?? process.env.GOOGLE_OAUTH_CLIENT_FILE;
  if (explicit) return explicit;

  const bundledConfigPath = resolveBundledGoogleOAuthClientFile();
  if (bundledConfigPath) return bundledConfigPath;

  const userConfigPath = join(homedir(), ".cued", "google-oauth-client.json");
  if (existsSync(userConfigPath)) return userConfigPath;

  return userConfigPath;
}

export function readGoogleOAuthClientConfig(filePath = resolveGoogleOAuthClientFile()) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    installed?: Record<string, unknown>;
    web?: Record<string, unknown>;
  };
  const source = parsed.installed ?? parsed.web;
  if (!source) {
    throw new Error(`Google OAuth client file is missing installed/web config: ${filePath}`);
  }
  const clientId = typeof source.client_id === "string" ? source.client_id : "";
  const clientSecret = typeof source.client_secret === "string" ? source.client_secret : "";
  const authUri =
    typeof source.auth_uri === "string"
      ? source.auth_uri
      : "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUri =
    typeof source.token_uri === "string" ? source.token_uri : "https://oauth2.googleapis.com/token";
  if (!clientId || !clientSecret) {
    throw new Error(`Google OAuth client file is missing client_id/client_secret: ${filePath}`);
  }
  return {
    config: { clientId, clientSecret, authUri, tokenUri } satisfies GoogleOAuthClientConfig,
    filePath,
  };
}

export function readGoogleOAuthClientConfigForCredentials(
  credentials: StoredGmailCredentials,
): ReturnType<typeof readGoogleOAuthClientConfig> {
  if (credentials.oauthClientFile) {
    return readGoogleOAuthClientConfig(credentials.oauthClientFile);
  }
  if (credentials.clientId && credentials.clientSecret) {
    return {
      config: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        authUri: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUri: credentials.tokenUri || "https://oauth2.googleapis.com/token",
      },
      filePath: "keychain-legacy",
    };
  }
  return readGoogleOAuthClientConfig();
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildOAuthUrl(input: {
  config: GoogleOAuthClientConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.config.authUri);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_READONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCodeForTokens(input: {
  config: GoogleOAuthClientConfig;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GmailTokenPayload> {
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await fetch(input.config.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(parsed)}`);
  }
  return parsed as unknown as GmailTokenPayload;
}
