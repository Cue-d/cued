import type {
  DiscordChannel,
  DiscordGuild,
  DiscordMessage,
  DiscordStoredCredentials,
  DiscordUser,
} from "../types.js";

const API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_MAX_RETRIES = 2;
const DISCORD_OVERFLOW_RETRY_BASE_MS = 2_000;

type FetchLike = typeof fetch;

export class DiscordApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(
      `Discord API ${method} ${path} failed (${status}): ${
        responseBody.length > 0 ? responseBody : String(status)
      }`,
    );
    this.name = "DiscordApiError";
  }
}

export class DiscordRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Discord API rate limited; retry after ${retryAfterMs}ms`);
    this.name = "DiscordRateLimitError";
  }
}

export class DiscordApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly credentials: Pick<DiscordStoredCredentials, "token">,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCurrentUser(): Promise<DiscordUser> {
    return await this.request<DiscordUser>("/users/@me");
  }

  async listPrivateChannels(): Promise<DiscordChannel[]> {
    return await this.request<DiscordChannel[]>("/users/@me/channels");
  }

  async listCurrentUserGuilds(): Promise<DiscordGuild[]> {
    return await this.request<DiscordGuild[]>("/users/@me/guilds");
  }

  async listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    return await this.request<DiscordChannel[]>(`/guilds/${guildId}/channels`);
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    return await this.request<DiscordChannel>(`/channels/${channelId}`);
  }

  async listChannelMessages(
    channelId: string,
    options: { after?: string | null; before?: string | null; limit?: number } = {},
  ): Promise<DiscordMessage[]> {
    const query = new URLSearchParams();
    if (options.after) {
      query.set("after", options.after);
    }
    if (options.before) {
      query.set("before", options.before);
    }
    if (options.limit) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return await this.request<DiscordMessage[]>(`/channels/${channelId}/messages${suffix}`);
  }

  async getChannelMessage(channelId: string, messageId: string): Promise<DiscordMessage> {
    return await this.request<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`);
  }

  async sendMessage(
    channelId: string,
    content: string,
    options: { replyToMessageId?: string | null } = {},
  ): Promise<DiscordMessage> {
    return await this.request<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: {
        content,
        allowed_mentions: { parse: [] as string[] },
        ...(options.replyToMessageId
          ? {
              message_reference: {
                message_id: options.replyToMessageId,
              },
            }
          : {}),
      },
    });
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < DEFAULT_MAX_RETRIES) {
      try {
        return await this.requestOnce<T>(path, options);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= DEFAULT_MAX_RETRIES || !isRetryableDiscordError(error)) {
          break;
        }
        await delay(getDiscordRetryDelayMs(error, attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const response = await this.fetchImpl(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: this.credentials.token,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cued/1.0",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 429) {
      const retryBody = (await safeJson(response)) as { retry_after?: number } | null;
      const retryAfterMs = Math.ceil((retryBody?.retry_after ?? 1) * 1000);
      throw new DiscordRateLimitError(Math.max(250, retryAfterMs));
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new DiscordApiError(
        options.method ?? "GET",
        path,
        response.status,
        body || response.statusText,
      );
    }

    return (await response.json()) as T;
  }
}

export function isDiscordAuthInvalidationError(error: unknown): boolean {
  if (error instanceof DiscordApiError) {
    if (error.status === 401 || error.status === 403) {
      return true;
    }
    const responseBody = error.responseBody.toLowerCase();
    return (
      responseBody.includes("password") ||
      responseBody.includes("unauthorized") ||
      responseBody.includes("limited access") ||
      responseBody.includes("suspicious")
    );
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("password") ||
    message.includes("limited access") ||
    message.includes("suspicious")
  );
}

export function isDiscordOverflowError(error: unknown): boolean {
  if (error instanceof DiscordApiError) {
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return true;
    }
    const responseBody = error.responseBody.toLowerCase();
    return responseBody.includes("overflow") || responseBody.includes("upstream connect error");
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("overflow") || message.includes("upstream connect error");
}

export function isDiscordRateLimitError(error: unknown): boolean {
  return (
    error instanceof DiscordRateLimitError ||
    (error instanceof Error && error.message.toLowerCase().includes("rate limited"))
  );
}

export function getDiscordRetryAfterMs(error: unknown): number | null {
  if (error instanceof DiscordRateLimitError) {
    return error.retryAfterMs;
  }
  return null;
}

function isRetryableDiscordError(error: unknown): boolean {
  if (isDiscordAuthInvalidationError(error)) {
    return false;
  }
  if (isDiscordOverflowError(error) || isDiscordRateLimitError(error)) {
    return true;
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("rate limited") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("econnreset") ||
    message.includes("unexpected end")
  );
}

function getDiscordRetryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof DiscordRateLimitError) {
    return error.retryAfterMs;
  }
  if (isDiscordOverflowError(error)) {
    return DISCORD_OVERFLOW_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  }
  return 250 * 2 ** Math.max(0, attempt - 1);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
