import { spawn } from "node:child_process";
import type {
  SlackConversationsResult,
  SlackMessagesResult,
  SlackTransport,
  SlackUsersResult,
} from "../transport.js";
import type { SlackCredentials } from "../types.js";
import { resolveSlackHelperBinary } from "./binary.js";

interface SlackHelperCommandEnvelope<TResult = unknown> {
  ok: boolean;
  protocolVersion: number;
  error?: string;
  result?: TResult;
}

type SpawnImpl = typeof spawn;

const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 500;

export class SlackHelperClient implements SlackTransport {
  private readonly helperPath: string;
  private readonly spawnImpl: SpawnImpl;
  private readonly retryAttempts: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly credentials: SlackCredentials,
    options: {
      helperPath?: string | null;
      spawnImpl?: SpawnImpl;
      retryAttempts?: number;
      retryBaseMs?: number;
    } = {},
  ) {
    const helperPath = options.helperPath ?? resolveSlackHelperBinary();
    if (!helperPath) {
      throw new Error("Bundled Slack helper was not found");
    }

    this.helperPath = helperPath;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.retryAttempts = Math.max(1, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
  }

  async testAuth(): Promise<{
    ok: boolean;
    error?: string;
    team?: string;
    user?: string;
    team_id?: string;
    user_id?: string;
  }> {
    return await this.request("authTest", {});
  }

  async listUsers(cursor?: string, limit?: number): Promise<SlackUsersResult> {
    return await this.request("listUsers", {
      cursor,
      limit,
    });
  }

  async listConversations(
    types: string,
    cursor?: string,
    limit?: number,
  ): Promise<SlackConversationsResult> {
    return await this.request("listConversations", {
      types,
      cursor,
      limit,
    });
  }

  async getConversationMembers(
    channel: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ members: string[]; nextCursor?: string }> {
    return await this.request("getConversationMembers", {
      channel,
      cursor,
      limit,
    });
  }

  async getHistory(
    channel: string,
    options: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    } = {},
  ): Promise<SlackMessagesResult> {
    return await this.request("getHistory", {
      channel,
      ...options,
    });
  }

  async getReplies(
    channel: string,
    threadTs: string,
    options: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    } = {},
  ): Promise<SlackMessagesResult> {
    return await this.request("getReplies", {
      channel,
      threadTs,
      ...options,
    });
  }

  private async request<TResult>(
    command:
      | "authTest"
      | "listUsers"
      | "listConversations"
      | "getConversationMembers"
      | "getHistory"
      | "getReplies",
    payload: Record<string, unknown>,
  ): Promise<TResult> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < this.retryAttempts) {
      try {
        return await this.requestOnce<TResult>(command, payload);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= this.retryAttempts || !isRetryableSlackHelperError(error)) {
          break;
        }
        await delay(this.retryBaseMs * 2 ** (attempt - 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce<TResult>(
    command:
      | "authTest"
      | "listUsers"
      | "listConversations"
      | "getConversationMembers"
      | "getHistory"
      | "getReplies",
    payload: Record<string, unknown>,
  ): Promise<TResult> {
    const child = this.spawnImpl(this.helperPath, [command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const input = JSON.stringify({
      credentials: this.credentials,
      ...payload,
    });

    return await new Promise<TResult>((resolve, reject) => {
      const rejectWithExit = (code: number | null) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const parsed = stdout ? tryParseHelperEnvelope<TResult>(stdout) : null;
        if (parsed?.error) {
          reject(new Error(parsed.error));
          return;
        }
        reject(
          new Error(
            stderr || stdout || `Slack helper exited with code ${code ?? "unknown"} for ${command}`,
          ),
        );
      };

      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          rejectWithExit(code);
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const parsed = tryParseHelperEnvelope<TResult>(stdout);
        if (!parsed) {
          reject(new Error(`Slack helper returned invalid JSON for ${command}`));
          return;
        }
        if (parsed.protocolVersion !== 1) {
          reject(
            new Error(`Slack helper protocol mismatch (${parsed.protocolVersion}) for ${command}`),
          );
          return;
        }
        if (!parsed.ok) {
          reject(new Error(parsed.error ?? `Slack helper command failed: ${command}`));
          return;
        }
        resolve(parsed.result as TResult);
      });

      child.stdin?.end(input);
    });
  }
}

function tryParseHelperEnvelope<TResult>(raw: string): SlackHelperCommandEnvelope<TResult> | null {
  try {
    return JSON.parse(raw) as SlackHelperCommandEnvelope<TResult>;
  } catch {
    return null;
  }
}

function isRetryableSlackHelperError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("tls handshake timeout") ||
    message.includes("context deadline exceeded") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("connection reset") ||
    message.includes("unexpected eof") ||
    message.includes("client timeout") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
