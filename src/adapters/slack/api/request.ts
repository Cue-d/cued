import { DEFAULT_HEADERS, RETRY_CONFIG, SLACK_API_BASE } from "./constants.js";
import type { SlackCredentials } from "./types.js";

export class SlackAuthError extends Error {
  constructor(
    message: string,
    public readonly slackError: string,
  ) {
    super(message);
    this.name = "SlackAuthError";
  }
}

export class SlackRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly slackError?: string,
    public readonly response?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SlackRequestError";
  }
}

class SlackRequest {
  private readonly headers: Record<string, string>;
  private readonly formData = new Map<string, string>();

  constructor(
    private readonly url: string,
    private readonly credentials: SlackCredentials,
  ) {
    this.headers = {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `d=${credentials.cookie}`,
    };
  }

  withParams(params: Record<string, string | number | boolean | undefined>): this {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        this.formData.set(key, String(value));
      }
    }
    return this;
  }

  private buildBody(): string {
    const params = new URLSearchParams();
    params.set("token", this.credentials.token);
    for (const [key, value] of this.formData) {
      params.set(key, value);
    }
    return params.toString();
  }

  async doJSON<T>(): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt += 1) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: this.headers,
          body: this.buildBody(),
        });

        if ((RETRY_CONFIG.authErrorStatusCodes as readonly number[]).includes(response.status)) {
          throw new SlackAuthError(
            `Authentication failed: ${response.status} ${response.statusText}`,
            "http_auth_error",
          );
        }

        if ((RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(response.status)) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          if (attempt < RETRY_CONFIG.maxRetries) {
            await sleep(retryAfterMs ?? RETRY_CONFIG.baseDelayMs * 2 ** attempt);
            continue;
          }
          throw new SlackRequestError(
            `Slack request failed: ${response.status}`,
            response.status,
            undefined,
            undefined,
            retryAfterMs ?? undefined,
          );
        }

        const text = await response.text();
        const data = JSON.parse(text) as T & { ok?: boolean; error?: string };
        if (data.ok === false) {
          const error = data.error ?? "unknown_error";
          if (error === "ratelimited") {
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            if (attempt < RETRY_CONFIG.maxRetries) {
              await sleep(retryAfterMs ?? RETRY_CONFIG.baseDelayMs * 2 ** attempt);
              continue;
            }
            throw new SlackRequestError(
              "Slack API error: ratelimited",
              response.status || 429,
              error,
              text,
              retryAfterMs ?? undefined,
            );
          }
          if ((RETRY_CONFIG.tokenExpiredErrors as readonly string[]).includes(error)) {
            throw new SlackAuthError(`Slack authentication failed: ${error}`, error);
          }
          throw new SlackRequestError(`Slack API error: ${error}`, response.status, error, text);
        }
        return data;
      } catch (error) {
        if (error instanceof SlackAuthError || error instanceof SlackRequestError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < RETRY_CONFIG.maxRetries) {
          await sleep(RETRY_CONFIG.baseDelayMs * 2 ** attempt);
        }
      }
    }

    throw new SlackRequestError(lastError?.message ?? "Unknown Slack request error", 0);
  }
}

export function newPostRequest(endpoint: string, credentials: SlackCredentials): SlackRequest {
  const url = endpoint.startsWith("http") ? endpoint : `${SLACK_API_BASE}/${endpoint}`;
  return new SlackRequest(url, credentials);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.round(seconds * 1000));
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
