import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { createLogger } from "../../../core/logging.js";
import { type SignalReceivedMessage, toSignalMessage } from "../cli/client.js";

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

interface SignalJsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

interface SignalRealtimeSessionOptions {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
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
  stopAndWait(): Promise<void>;
  getStatus(): SignalRealtimeStatus;
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
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly onMessage?: (message: SignalReceivedMessage) => void;
  private readonly onConnected?: (status: SignalRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: SignalRealtimeStatus) => void;
  private readonly onStatusChange?: (status: SignalRealtimeStatus) => void;

  private child: ChildProcess | null = null;
  private readLine: ReadLineInterface | null = null;
  private nextNotificationIndex = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private hasEverConnected = false;
  private stopping = false;
  private status: SignalRealtimeStatus;

  constructor(options: SignalRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.account = options.account;
    this.cliPath = options.cliPath;
    this.configDir = options.configDir;
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
    void this.stopAndWait();
  }

  async stopAndWait(): Promise<void> {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    const child = this.child;
    if (!child) {
      this.stopping = false;
      this.setStatus({
        state: "stopped",
        connectedAt: null,
        lastSessionError: null,
      });
      return;
    }

    this.stopping = true;
    await this.waitForChildExit(child);
  }

  getStatus(): SignalRealtimeStatus {
    return { ...this.status };
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
          ? `Bundled Signal helper jsonRpc exited with code ${code}`
          : signal
            ? `Bundled Signal helper jsonRpc exited with signal ${signal}`
            : "Bundled Signal helper jsonRpc exited";
      this.handleExit(new Error(reason));
    });
  }

  private handleStdoutLine(line: string): void {
    const message = parseSignalJsonRpcLine(line);
    if (!message) {
      return;
    }

    if (message.id != null || message.method !== "receive" || message.params == null) {
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
    const intentionalStop = this.stopping;
    this.stopping = false;
    this.disposeChild();
    if (!wasActive) {
      return;
    }

    if (intentionalStop) {
      this.setStatus({
        state: "stopped",
        connectedAt: null,
        lastSessionError: null,
      });
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

  private async waitForChildExit(child: ChildProcess): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }, 5_000);

      child.once("exit", finish);
      child.once("error", finish);
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    });
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
    for (const managed of this.sessions.values()) {
      managed.session.stop();
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

  async stopSession(accountKey: string): Promise<void> {
    const session = this.sessions.get(accountKey)?.session;
    if (!session) {
      return;
    }

    await session.stopAndWait();
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
