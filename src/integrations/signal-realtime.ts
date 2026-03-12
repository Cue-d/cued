import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { createLogger } from "../logging.js";
import { type SignalReceivedMessage, toSignalMessage } from "./signal-cli.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const signalLogger = createLogger("signal");

export type SignalRealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "stopped";

export interface SignalRealtimeStatus {
  platform: "signal";
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
  state: SignalRealtimeState;
  connectedAt: number | null;
  lastNotificationAt: number | null;
  lastReconnectAt: number | null;
  reconnectAttempts: number;
  lastSessionError: string | null;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface SignalJsonRpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: unknown;
}

interface SignalRealtimeSessionOptions {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  spawnImpl?: typeof spawn;
  onMessage?: (message: SignalReceivedMessage) => void;
  onConnected?: (status: SignalRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (status: SignalRealtimeStatus) => void;
  onStatusChange?: (status: SignalRealtimeStatus) => void;
}

export interface SignalRealtimeSessionLike {
  start(): void;
  stop(): void;
  getStatus(): SignalRealtimeStatus;
  isConnected(): boolean;
  sendMessage(
    text: string,
    target: { recipient?: string; groupId?: string },
  ): Promise<{ timestamp: number }>;
}

export interface SignalRealtimeSupervisorSessionInput {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
}

interface SignalRealtimeSupervisorOptions {
  createSession?: (input: SignalRealtimeSupervisorSessionInput) => SignalRealtimeSessionLike;
  onMessage?: (accountKey: string, message: SignalReceivedMessage) => void;
  onConnected?: (accountKey: string, status: SignalRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (accountKey: string, status: SignalRealtimeStatus) => void;
  onStatusChange?: (accountKey: string, status: SignalRealtimeStatus) => void;
}

export function parseSignalJsonRpcLine(line: string): SignalJsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as SignalJsonRpcMessage;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

function makeStatus(input: {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
  state?: SignalRealtimeState;
  connectedAt?: number | null;
  lastNotificationAt?: number | null;
  lastReconnectAt?: number | null;
  reconnectAttempts?: number;
  lastSessionError?: string | null;
}): SignalRealtimeStatus {
  return {
    platform: "signal",
    accountKey: input.accountKey,
    account: input.account,
    cliPath: input.cliPath,
    configDir: input.configDir,
    state: input.state ?? "stopped",
    connectedAt: input.connectedAt ?? null,
    lastNotificationAt: input.lastNotificationAt ?? null,
    lastReconnectAt: input.lastReconnectAt ?? null,
    reconnectAttempts: input.reconnectAttempts ?? 0,
    lastSessionError: input.lastSessionError ?? null,
  };
}

export class SignalRealtimeSession implements SignalRealtimeSessionLike {
  private readonly accountKey: string;
  private readonly account: string;
  private readonly cliPath: string;
  private readonly configDir: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly onMessage?: (message: SignalReceivedMessage) => void;
  private readonly onConnected?: (status: SignalRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: SignalRealtimeStatus) => void;
  private readonly onStatusChange?: (status: SignalRealtimeStatus) => void;

  private child: ChildProcess | null = null;
  private readLine: ReadLineInterface | null = null;
  private nextRequestId = 1;
  private nextNotificationIndex = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private hasEverConnected = false;
  private status: SignalRealtimeStatus;

  constructor(options: SignalRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.account = options.account;
    this.cliPath = options.cliPath;
    this.configDir = options.configDir;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.onMessage = options.onMessage;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.status = makeStatus({
      accountKey: this.accountKey,
      account: this.account,
      cliPath: this.cliPath,
      configDir: this.configDir,
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
    this.rejectPendingRequests("Signal realtime session stopped");
    this.disposeChild();
    this.setStatus({
      state: "stopped",
      connectedAt: null,
      lastSessionError: null,
    });
  }

  getStatus(): SignalRealtimeStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === "connected" && Boolean(this.child?.stdin?.writable);
  }

  async sendMessage(
    text: string,
    target: { recipient?: string; groupId?: string },
  ): Promise<{ timestamp: number }> {
    const message = text.trim();
    if (message.length === 0) {
      throw new Error("Signal message text is required");
    }

    const params: Record<string, unknown> = { message };
    if (target.groupId) {
      params.groupId = target.groupId;
    } else if (target.recipient) {
      params.recipient = [target.recipient];
    } else {
      throw new Error("Signal message requires a recipient or groupId");
    }

    const result = await this.request<{ timestamp?: number }>("send", params);
    return {
      timestamp: typeof result?.timestamp === "number" ? result.timestamp : now(),
    };
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin?.writable || !this.isConnected()) {
      throw new Error("Signal realtime session is not connected");
    }

    const id = this.nextRequestId++;
    const payload =
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n";

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Signal JSON-RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.child!.stdin!.write(payload, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to write Signal JSON-RPC request: ${error.message}`));
      });
    });
  }

  private spawnChild(): void {
    this.disposeChild();
    const child = this.spawnImpl(
      this.cliPath,
      [
        "--config",
        this.configDir,
        "-u",
        this.account,
        "-o",
        "json",
        "jsonRpc",
        "--receive-mode",
        "on-start",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );

    this.child = child;
    this.readLine = createInterface({ input: child.stdout! });
    this.readLine.on("line", (line) => this.handleStdoutLine(line));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (!message) {
        return;
      }
      this.setStatus({ lastSessionError: message });
      signalLogger.warn("realtime stderr", { accountKey: this.accountKey, message });
    });

    child.once("spawn", () => {
      const reconnected = this.hasEverConnected;
      this.hasEverConnected = true;
      this.setStatus({
        state: "connected",
        connectedAt: now(),
        reconnectAttempts: 0,
        lastSessionError: null,
      });
      this.onConnected?.(this.getStatus(), reconnected);
    });

    child.once("error", (error) => {
      this.handleExit(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("exit", (code, signal) => {
      const reason =
        code && code !== 0
          ? `signal-cli jsonRpc exited with code ${code}`
          : signal
            ? `signal-cli jsonRpc exited with signal ${signal}`
            : "signal-cli jsonRpc exited";
      this.handleExit(new Error(reason));
    });
  }

  private handleStdoutLine(line: string): void {
    const message = parseSignalJsonRpcLine(line);
    if (!message) {
      return;
    }

    if (message.id != null) {
      const numericId = Number(message.id);
      const pending = Number.isFinite(numericId) ? this.pendingRequests.get(numericId) : undefined;
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(numericId);
      clearTimeout(pending.timeout);
      if (message.error?.message) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method !== "receive" || message.params == null) {
      return;
    }

    this.setStatus({ lastNotificationAt: now(), lastSessionError: null });
    const parsed = toSignalMessage(message.params, this.account, this.nextNotificationIndex++);
    if (parsed) {
      this.onMessage?.(parsed);
    }
  }

  private handleExit(error: Error): void {
    const wasActive = this.status.state !== "stopped";
    this.rejectPendingRequests(error.message);
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

  private rejectPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
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

  private setStatus(patch: Partial<SignalRealtimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.onStatusChange?.(this.getStatus());
  }
}

type ManagedSignalSession = {
  desired: SignalRealtimeSupervisorSessionInput;
  session: SignalRealtimeSessionLike;
};

export class SignalRealtimeSupervisor {
  private readonly createSession: (
    input: SignalRealtimeSupervisorSessionInput,
  ) => SignalRealtimeSessionLike;
  private readonly onMessage?: SignalRealtimeSupervisorOptions["onMessage"];
  private readonly onConnected?: SignalRealtimeSupervisorOptions["onConnected"];
  private readonly onDisconnected?: SignalRealtimeSupervisorOptions["onDisconnected"];
  private readonly onStatusChange?: SignalRealtimeSupervisorOptions["onStatusChange"];
  private readonly sessions = new Map<string, ManagedSignalSession>();
  private readonly degradedStatuses = new Map<string, SignalRealtimeStatus>();
  private readonly waiters = new Map<
    string,
    Array<{ resolve: (session: SignalRealtimeSessionLike | null) => void; timer: NodeJS.Timeout }>
  >();

  constructor(options: SignalRealtimeSupervisorOptions = {}) {
    this.onMessage = options.onMessage;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.createSession =
      options.createSession ??
      ((input) =>
        new SignalRealtimeSession({
          ...input,
          onMessage: (message) => this.onMessage?.(input.accountKey, message),
          onConnected: (status, reconnected) => {
            this.resolveWaiters(
              input.accountKey,
              this.sessions.get(input.accountKey)?.session ?? null,
            );
            this.onConnected?.(input.accountKey, status, reconnected);
          },
          onDisconnected: (status) => {
            this.onDisconnected?.(input.accountKey, status);
          },
          onStatusChange: (status) => {
            this.degradedStatuses.delete(input.accountKey);
            this.onStatusChange?.(input.accountKey, status);
          },
        }));
  }

  reconcile(
    desiredInputs: SignalRealtimeSupervisorSessionInput[],
    degradedInputs?: Array<Omit<SignalRealtimeStatus, "platform">>,
  ): void {
    const desiredByKey = new Map(desiredInputs.map((input) => [input.accountKey, input]));

    for (const [accountKey, managed] of this.sessions) {
      const desired = desiredByKey.get(accountKey);
      if (!desired || !this.sameDesiredSession(managed.desired, desired)) {
        managed.session.stop();
        this.sessions.delete(accountKey);
        this.resolveWaiters(accountKey, null);
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
      this.sessions.set(desired.accountKey, {
        desired,
        session,
      });
      session.start();
    }

    this.degradedStatuses.clear();
    for (const degraded of degradedInputs ?? []) {
      this.degradedStatuses.set(degraded.accountKey, {
        platform: "signal",
        ...degraded,
      });
    }
  }

  stopAll(): void {
    for (const [accountKey, managed] of this.sessions) {
      managed.session.stop();
      this.resolveWaiters(accountKey, null);
    }
    this.sessions.clear();
    this.degradedStatuses.clear();
  }

  getStatuses(): SignalRealtimeStatus[] {
    return [
      ...[...this.sessions.values()].map((managed) => managed.session.getStatus()),
      ...this.degradedStatuses.values(),
    ].sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  }

  getSession(accountKey: string): SignalRealtimeSessionLike | null {
    return this.sessions.get(accountKey)?.session ?? null;
  }

  async waitForConnected(
    accountKey: string,
    timeoutMs: number,
  ): Promise<SignalRealtimeSessionLike | null> {
    const existing = this.getSession(accountKey);
    if (existing?.isConnected()) {
      return existing;
    }

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(accountKey);
        if (!waiters) {
          resolve(null);
          return;
        }
        this.waiters.set(
          accountKey,
          waiters.filter((waiter) => waiter.timer !== timer),
        );
        resolve(null);
      }, timeoutMs);

      const waiters = this.waiters.get(accountKey) ?? [];
      waiters.push({ resolve, timer });
      this.waiters.set(accountKey, waiters);
    });
  }

  private resolveWaiters(accountKey: string, session: SignalRealtimeSessionLike | null): void {
    const waiters = this.waiters.get(accountKey);
    if (!waiters || waiters.length === 0) {
      return;
    }

    this.waiters.delete(accountKey);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(session?.isConnected() ? session : null);
    }
  }

  private sameDesiredSession(
    left: SignalRealtimeSupervisorSessionInput,
    right: SignalRealtimeSupervisorSessionInput,
  ): boolean {
    return (
      left.account === right.account &&
      left.accountKey === right.accountKey &&
      left.cliPath === right.cliPath &&
      left.configDir === right.configDir
    );
  }
}
