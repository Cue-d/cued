import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { createLogger } from "../../../core/logging.js";
import type { SlackConversation, SlackMessage, SlackUser } from "../api/index.js";
import type { SlackCredentials } from "../api/types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const slackLogger = createLogger("slack");

export type SlackRealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "stopped";

export interface SlackRealtimeStatus {
  platform: "slack";
  accountKey: string;
  helperPath: string;
  state: SlackRealtimeState;
  teamId: string | null;
  userId: string | null;
  transport: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  lastReconnectAt: number | null;
  reconnectAttempts: number;
  lastSessionError: string | null;
}

export type SlackRealtimeEventEnvelope =
  | {
      event: "connected";
      data: {
        teamId: string;
        userId: string;
        transport: string;
      };
    }
  | {
      event: "disconnected";
      data: {
        reason: string;
      };
    }
  | {
      event: "contact_upsert";
      data: {
        teamId: string;
        user: SlackUser;
      };
    }
  | {
      event: "conversation_upsert";
      data: {
        teamId: string;
        selfUserId: string;
        conversation: SlackConversation;
        memberIds: string[];
        displayName: string;
        isNew: boolean;
      };
    }
  | {
      event: "message_upsert";
      data: {
        teamId: string;
        selfUserId: string;
        conversationId: string;
        message: SlackMessage;
      };
    };

interface SlackRealtimeSessionOptions {
  accountKey: string;
  helperPath: string;
  credentials: SlackCredentials;
  pollIntervalMs?: number;
  userRefreshMs?: number;
  conversationLimit?: number;
  messageLimit?: number;
  connectTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  spawnImpl?: typeof spawn;
  onEvent?: (accountKey: string, event: SlackRealtimeEventEnvelope) => void;
  onConnected?: (status: SlackRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (status: SlackRealtimeStatus) => void;
  onStatusChange?: (status: SlackRealtimeStatus) => void;
}

export interface SlackRealtimeSessionLike {
  start(): void;
  stop(): void;
  getStatus(): SlackRealtimeStatus;
  isConnected(): boolean;
}

export interface SlackRealtimeSupervisorSessionInput {
  accountKey: string;
  helperPath: string;
  credentials: SlackCredentials;
  pollIntervalMs?: number;
  userRefreshMs?: number;
  conversationLimit?: number;
  messageLimit?: number;
}

interface SlackRealtimeSupervisorOptions {
  createSession?: (input: SlackRealtimeSupervisorSessionInput) => SlackRealtimeSessionLike;
  onEvent?: (accountKey: string, event: SlackRealtimeEventEnvelope) => void;
  onConnected?: (accountKey: string, status: SlackRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (accountKey: string, status: SlackRealtimeStatus) => void;
  onStatusChange?: (accountKey: string, status: SlackRealtimeStatus) => void;
}

function now(): number {
  return Date.now();
}

function makeStatus(input: {
  accountKey: string;
  helperPath: string;
  state?: SlackRealtimeState;
  teamId?: string | null;
  userId?: string | null;
  transport?: string | null;
  connectedAt?: number | null;
  lastEventAt?: number | null;
  lastReconnectAt?: number | null;
  reconnectAttempts?: number;
  lastSessionError?: string | null;
}): SlackRealtimeStatus {
  return {
    platform: "slack",
    accountKey: input.accountKey,
    helperPath: input.helperPath,
    state: input.state ?? "stopped",
    teamId: input.teamId ?? null,
    userId: input.userId ?? null,
    transport: input.transport ?? null,
    connectedAt: input.connectedAt ?? null,
    lastEventAt: input.lastEventAt ?? null,
    lastReconnectAt: input.lastReconnectAt ?? null,
    reconnectAttempts: input.reconnectAttempts ?? 0,
    lastSessionError: input.lastSessionError ?? null,
  };
}

export function parseSlackRealtimeHelperLine(line: string): SlackRealtimeEventEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { event?: unknown; data?: unknown };
    return typeof parsed.event === "string" ? (parsed as SlackRealtimeEventEnvelope) : null;
  } catch {
    return null;
  }
}

export class SlackRealtimeSession implements SlackRealtimeSessionLike {
  private readonly accountKey: string;
  private readonly helperPath: string;
  private readonly credentials: SlackCredentials;
  private readonly pollIntervalMs?: number;
  private readonly userRefreshMs?: number;
  private readonly conversationLimit?: number;
  private readonly messageLimit?: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly onEvent?: (accountKey: string, event: SlackRealtimeEventEnvelope) => void;
  private readonly onConnected?: (status: SlackRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: SlackRealtimeStatus) => void;
  private readonly onStatusChange?: (status: SlackRealtimeStatus) => void;

  private child: ChildProcess | null = null;
  private readLine: ReadLineInterface | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private hasEverConnected = false;
  private status: SlackRealtimeStatus;

  constructor(options: SlackRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.helperPath = options.helperPath;
    this.credentials = options.credentials;
    this.pollIntervalMs = options.pollIntervalMs;
    this.userRefreshMs = options.userRefreshMs;
    this.conversationLimit = options.conversationLimit;
    this.messageLimit = options.messageLimit;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.status = makeStatus({
      accountKey: this.accountKey,
      helperPath: this.helperPath,
    });
  }

  start(): void {
    if (this.shouldReconnect && this.child) {
      return;
    }
    this.shouldReconnect = true;
    this.setStatus({
      state: this.hasEverConnected ? "reconnecting" : "connecting",
      lastSessionError: null,
    });
    this.spawnChild();
  }

  stop(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.disposeChild();
    this.setStatus({
      state: "stopped",
      connectedAt: null,
      lastSessionError: null,
    });
  }

  getStatus(): SlackRealtimeStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === "connected";
  }

  private spawnChild(): void {
    this.disposeChild();
    const child = this.spawnImpl(this.helperPath, ["session"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child = child;
    this.readLine = createInterface({ input: child.stdout! });
    this.readLine.on("line", (line) => this.handleStdoutLine(line));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (!message) {
        return;
      }
      this.setStatus({ lastSessionError: message });
      slackLogger.warn("realtime stderr", { accountKey: this.accountKey, message });
    });

    child.once("spawn", () => {
      this.setStatus({
        state: this.hasEverConnected ? "reconnecting" : "connecting",
        connectedAt: null,
        lastSessionError: null,
      });
      const request = JSON.stringify({
        credentials: this.credentials,
        pollIntervalMs: this.pollIntervalMs,
        userRefreshMs: this.userRefreshMs,
        conversationLimit: this.conversationLimit,
        messageLimit: this.messageLimit,
      });
      child.stdin?.end(request);
      this.startConnectTimer();
    });

    child.once("error", (error) => {
      this.handleExit(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("exit", (code, signal) => {
      const reason =
        code && code !== 0
          ? `Slack helper session exited with code ${code}`
          : signal
            ? `Slack helper session exited with signal ${signal}`
            : "Slack helper session exited";
      this.handleExit(new Error(reason));
    });
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseSlackRealtimeHelperLine(line);
    if (!parsed) {
      return;
    }

    const eventAt = now();
    if (parsed.event === "connected") {
      const reconnected = this.hasEverConnected;
      this.hasEverConnected = true;
      this.clearConnectTimer();
      this.setStatus({
        lastEventAt: eventAt,
        state: "connected",
        teamId: parsed.data.teamId,
        userId: parsed.data.userId,
        transport: parsed.data.transport,
        connectedAt: eventAt,
        reconnectAttempts: 0,
        lastSessionError: null,
      });
      this.onConnected?.(this.getStatus(), reconnected);
      return;
    }

    if (parsed.event === "disconnected") {
      this.setStatus({
        lastEventAt: eventAt,
        state: this.shouldReconnect ? "reconnecting" : "degraded",
        connectedAt: null,
        lastSessionError: parsed.data.reason,
      });
    } else {
      this.setStatus({
        lastEventAt: eventAt,
      });
    }

    this.onEvent?.(this.accountKey, parsed);
  }

  private handleExit(error: Error): void {
    const wasActive = this.status.state !== "stopped";
    this.clearConnectTimer();
    this.disposeChild();
    if (!wasActive) {
      return;
    }

    const reconnectAttempts = this.shouldReconnect
      ? this.status.reconnectAttempts + 1
      : this.status.reconnectAttempts;
    this.setStatus({
      state: this.shouldReconnect ? "reconnecting" : "degraded",
      connectedAt: null,
      reconnectAttempts,
      lastReconnectAt: this.shouldReconnect ? now() : this.status.lastReconnectAt,
      lastSessionError: error.message,
    });
    this.onDisconnected?.(this.getStatus());
    if (!this.shouldReconnect) {
      return;
    }

    const delayMs = Math.min(
      this.reconnectBaseMs * Math.max(1, reconnectAttempts),
      this.reconnectMaxMs,
    );
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) {
        return;
      }
      this.setStatus({ state: "reconnecting" });
      this.spawnChild();
    }, delayMs);
  }

  private disposeChild(): void {
    this.readLine?.close();
    this.readLine = null;
    if (this.child) {
      this.child.removeAllListeners();
      if (!this.child.killed) {
        this.child.kill("SIGTERM");
      }
      this.child = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startConnectTimer(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.handleExit(
        new Error(`Slack helper did not emit connected within ${this.connectTimeoutMs}ms`),
      );
    }, this.connectTimeoutMs);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private setStatus(patch: Partial<SlackRealtimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.onStatusChange?.(this.getStatus());
  }
}

type ManagedSlackSession = {
  desired: SlackRealtimeSupervisorSessionInput;
  session: SlackRealtimeSessionLike;
};

export class SlackRealtimeSupervisor {
  private readonly createSession: (
    input: SlackRealtimeSupervisorSessionInput,
  ) => SlackRealtimeSessionLike;
  private readonly onEvent?: SlackRealtimeSupervisorOptions["onEvent"];
  private readonly onConnected?: SlackRealtimeSupervisorOptions["onConnected"];
  private readonly onDisconnected?: SlackRealtimeSupervisorOptions["onDisconnected"];
  private readonly onStatusChange?: SlackRealtimeSupervisorOptions["onStatusChange"];
  private readonly sessions = new Map<string, ManagedSlackSession>();
  private readonly degradedStatuses = new Map<string, SlackRealtimeStatus>();

  constructor(options: SlackRealtimeSupervisorOptions = {}) {
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.createSession =
      options.createSession ??
      ((input) =>
        new SlackRealtimeSession({
          ...input,
          onEvent: (accountKey, event) => this.onEvent?.(accountKey, event),
          onConnected: (status, reconnected) =>
            this.onConnected?.(input.accountKey, status, reconnected),
          onDisconnected: (status) => this.onDisconnected?.(input.accountKey, status),
          onStatusChange: (status) => {
            this.degradedStatuses.delete(input.accountKey);
            this.onStatusChange?.(input.accountKey, status);
          },
        }));
  }

  reconcile(
    desiredInputs: SlackRealtimeSupervisorSessionInput[],
    degradedInputs?: Array<Omit<SlackRealtimeStatus, "platform">>,
  ): void {
    const desiredByKey = new Map(desiredInputs.map((input) => [input.accountKey, input]));
    for (const [accountKey, existing] of this.sessions) {
      const desired = desiredByKey.get(accountKey);
      if (!desired || !sameDesiredSession(existing.desired, desired)) {
        existing.session.stop();
        this.sessions.delete(accountKey);
      }
    }

    for (const desired of desiredInputs) {
      const existing = this.sessions.get(desired.accountKey);
      if (existing) {
        this.degradedStatuses.delete(desired.accountKey);
        const status = existing.session.getStatus();
        if (status.state === "stopped" || status.state === "degraded") {
          existing.session.start();
        }
        continue;
      }

      const session = this.createSession(desired);
      this.sessions.set(desired.accountKey, { desired, session });
      session.start();
    }

    this.degradedStatuses.clear();
    for (const degraded of degradedInputs ?? []) {
      this.degradedStatuses.set(degraded.accountKey, {
        platform: "slack",
        ...degraded,
      });
    }
  }

  stopAll(): void {
    for (const managed of this.sessions.values()) {
      managed.session.stop();
    }
    this.sessions.clear();
    this.degradedStatuses.clear();
  }

  getSession(accountKey: string): SlackRealtimeSessionLike | null {
    return this.sessions.get(accountKey)?.session ?? null;
  }

  getStatuses(): SlackRealtimeStatus[] {
    return [
      ...[...this.sessions.values()].map((managed) => managed.session.getStatus()),
      ...this.degradedStatuses.values(),
    ].sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  }
}

function sameDesiredSession(
  left: SlackRealtimeSupervisorSessionInput,
  right: SlackRealtimeSupervisorSessionInput,
): boolean {
  return (
    left.accountKey === right.accountKey &&
    left.helperPath === right.helperPath &&
    left.credentials.token === right.credentials.token &&
    left.credentials.cookie === right.credentials.cookie &&
    left.pollIntervalMs === right.pollIntervalMs &&
    left.userRefreshMs === right.userRefreshMs &&
    left.conversationLimit === right.conversationLimit &&
    left.messageLimit === right.messageLimit
  );
}
