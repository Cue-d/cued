import { execFileSync } from "node:child_process";
import {
  GMAIL_KEYCHAIN_SERVICE,
  readGoogleOAuthClientConfigForCredentials,
  type StoredGmailCredentials,
} from "../oauth/client.js";

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

export interface GmailMessageListPage {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryMessageRef {
  id: string;
  threadId: string;
}

export interface GmailHistoryRecord {
  id?: string;
  messages?: GmailHistoryMessageRef[];
  messagesAdded?: Array<{ message: GmailHistoryMessageRef }>;
}

export interface GmailHistoryListPage {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePayload;
}

export interface GmailMessagePayload {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePayload[];
}

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>,
  ) {
    super(`Gmail API request failed (${status}): ${JSON.stringify(payload)}`);
    this.name = "GmailApiError";
  }
}

export function isGmailApiError(error: unknown, status?: number): error is GmailApiError {
  return error instanceof GmailApiError && (status == null || error.status === status);
}

export function readGmailSecret(accountKey: string): StoredGmailCredentials {
  const stdout = execFileSync(
    "security",
    ["find-generic-password", "-s", GMAIL_KEYCHAIN_SERVICE, "-a", accountKey, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as StoredGmailCredentials;
}

export function writeGmailSecret(accountKey: string, credentials: StoredGmailCredentials): void {
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      GMAIL_KEYCHAIN_SERVICE,
      "-a",
      accountKey,
      "-w",
      JSON.stringify(credentials),
    ],
    { stdio: "ignore" },
  );
}

export class GmailClient {
  private credentials: StoredGmailCredentials;

  constructor(
    credentials: StoredGmailCredentials,
    private readonly accountKeyForSecret: string,
  ) {
    this.credentials = credentials;
  }

  static fromKeychain(accountKey: string): GmailClient {
    return new GmailClient(readGmailSecret(accountKey), accountKey);
  }

  async getProfile(): Promise<GmailProfile> {
    return this.request<GmailProfile>("/gmail/v1/users/me/profile");
  }

  async listMessages(input: {
    pageToken?: string | null;
    maxResults: number;
  }): Promise<GmailMessageListPage> {
    const params = new URLSearchParams({
      includeSpamTrash: "false",
      maxResults: String(input.maxResults),
      q: "-in:spam -in:trash",
    });
    if (input.pageToken) {
      params.set("pageToken", input.pageToken);
    }
    return this.request<GmailMessageListPage>(`/gmail/v1/users/me/messages?${params}`);
  }

  async listHistory(input: {
    startHistoryId: string;
    pageToken?: string | null;
    maxResults: number;
  }): Promise<GmailHistoryListPage> {
    const params = new URLSearchParams({
      historyTypes: "messageAdded",
      maxResults: String(input.maxResults),
      startHistoryId: input.startHistoryId,
    });
    if (input.pageToken) {
      params.set("pageToken", input.pageToken);
    }
    return this.request<GmailHistoryListPage>(`/gmail/v1/users/me/history?${params}`);
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: "full" });
    return this.request<GmailMessage>(
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`,
    );
  }

  private async request<T>(path: string): Promise<T> {
    await this.refreshIfNeeded();
    const response = await fetch(`https://gmail.googleapis.com${path}`, {
      headers: { authorization: `Bearer ${this.credentials.accessToken}` },
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new GmailApiError(response.status, parsed);
    }
    return parsed as T;
  }

  private async refreshIfNeeded(): Promise<void> {
    if (this.credentials.expiresAt - Date.now() > 60_000) {
      return;
    }
    const { config } = readGoogleOAuthClientConfigForCredentials(this.credentials);
    const response = await fetch(config.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.credentials.refreshToken,
      }),
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof parsed.access_token !== "string") {
      throw new Error(`Gmail token refresh failed: ${JSON.stringify(parsed)}`);
    }
    this.credentials = {
      ...this.credentials,
      accessToken: parsed.access_token,
      expiresAt: Date.now() + Number(parsed.expires_in ?? 3600) * 1000,
      scope: typeof parsed.scope === "string" ? parsed.scope : this.credentials.scope,
    };
    writeGmailSecret(this.accountKeyForSecret, this.credentials);
  }
}
