import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import type { CuedDatabase } from "../../../db/database.js";
import { GmailClient, writeGmailSecret } from "../../gmail/api/client.js";
import {
  buildOAuthUrl,
  createPkcePair,
  exchangeCodeForTokens,
  GMAIL_KEYCHAIN_SERVICE,
  readGoogleOAuthClientConfig,
  type StoredGmailCredentials,
} from "../../gmail/oauth/client.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthAuthResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface OAuthAuthHandle {
  child: ChildProcess;
  completion: Promise<OAuthAuthResult>;
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
}

async function runGmailOAuthSession(
  session: AuthSessionSummary,
  _integration: IntegrationStateSummary,
): Promise<OAuthAuthResult> {
  if (session.platform !== "gmail") {
    throw new Error(`OAuth runtime is only implemented for Gmail, got ${session.platform}`);
  }
  const { config, filePath } = readGoogleOAuthClientConfig();
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString("hex");
  const timeoutMs = Number(process.env.CUED_OAUTH_TIMEOUT_MS ?? DEFAULT_OAUTH_TIMEOUT_MS);

  const codePromise = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const host = request.headers.host ?? "localhost";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (error) {
        response.end("<h1>Cued Gmail sign-in failed</h1><p>You can close this window.</p>");
        server.close();
        reject(new Error(`Google OAuth failed: ${error}`));
        return;
      }
      if (!code || returnedState !== state) {
        response.end("<h1>Cued Gmail sign-in failed</h1><p>Invalid OAuth response.</p>");
        server.close();
        reject(new Error("Google OAuth response was missing code or state"));
        return;
      }
      response.end("<h1>Cued Gmail sign-in complete</h1><p>You can close this window.</p>");
      const address = server.address() as AddressInfo;
      server.close();
      resolve({ code, redirectUri: `http://localhost:${address.port}` });
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error(`Google OAuth timed out after ${timeoutMs}ms waiting for loopback redirect`),
      );
    }, timeoutMs);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(0, "localhost", () => {
      const address = server.address() as AddressInfo;
      const redirectUri = `http://localhost:${address.port}`;
      const authUrl = buildOAuthUrl({
        config,
        redirectUri,
        state,
        codeChallenge: challenge,
      });
      process.stderr.write(`Open this URL to connect Gmail:\n${authUrl}\n`);
      openUrl(authUrl);
    });
    server.once("close", () => clearTimeout(timeout));
  });

  const { code, redirectUri } = await codePromise;
  const token = await exchangeCodeForTokens({ config, code, redirectUri, codeVerifier: verifier });
  if (!token.access_token || !token.refresh_token) {
    throw new Error("Google OAuth response did not include access and refresh tokens");
  }
  const provisional: StoredGmailCredentials = {
    oauthClientFile: filePath,
    tokenUri: config.tokenUri,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    scope: token.scope ?? "",
    emailAddress: session.accountKey,
  };
  const profile = await new GmailClient(provisional, session.accountKey).getProfile();
  const emailAddress = profile.emailAddress.trim();
  const credentials: StoredGmailCredentials = {
    ...provisional,
    emailAddress,
    historyId: profile.historyId ?? null,
    messagesTotal: profile.messagesTotal ?? null,
    threadsTotal: profile.threadsTotal ?? null,
  };
  writeGmailSecret(emailAddress, credentials);
  return {
    sessionId: session.id,
    platform: "gmail",
    accountKey: emailAddress,
    state: "authenticated",
    keychainService: GMAIL_KEYCHAIN_SERVICE,
    keychainAccount: emailAddress,
    resultSummary: {
      emailAddress,
      messagesTotal: profile.messagesTotal ?? null,
      threadsTotal: profile.threadsTotal ?? null,
      historyId: profile.historyId ?? null,
      oauthClientFile: filePath,
    },
  };
}

export function startOAuthAuthSession(
  _db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): OAuthAuthHandle {
  const child = spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename, JSON.stringify({ session, integration })],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const completion = new Promise<OAuthAuthResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0 && stdout) {
        resolve(JSON.parse(stdout) as OAuthAuthResult);
        return;
      }
      reject(
        new Error(stderr || stdout || `OAuth auth helper exited with code ${code ?? "unknown"}`),
      );
    });
  });
  return { child, completion };
}

export async function runOAuthAuthSessionSync(
  _db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): Promise<OAuthAuthResult> {
  return runGmailOAuthSession(session, integration);
}

async function main(): Promise<void> {
  if (process.argv.length < 3) return;
  const parsed = JSON.parse(process.argv[2]!) as {
    session: AuthSessionSummary;
    integration: IntegrationStateSummary;
  };
  const result = await runGmailOAuthSession(parsed.session, parsed.integration);
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
