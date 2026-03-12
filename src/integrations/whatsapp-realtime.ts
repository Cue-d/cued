import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { createLogger } from "../logging.js";
import type {
  WhatsAppHelperCommand,
  WhatsAppHelperEventEnvelope,
  WhatsAppHelperResponseEnvelope,
  WhatsAppHelperSendResult,
  WhatsAppSnapshot,
} from "./whatsapp-types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const whatsAppLogger = createLogger("whatsapp");

export type WhatsAppRealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "stopped";

export interface WhatsAppRealtimeStatus {
  platform: "whatsapp";
  accountKey: string;
  helperPath: string;
  storeDir: string;
  state: WhatsAppRealtimeState;
  accountJid: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  lastHistorySyncAt: number | null;
  lastReconnectAt: number | null;
  reconnectAttempts: number;
  lastSessionError: string | null;
}

interface PendingRequest {
  command: WhatsAppHelperCommand["command"];
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface WhatsAppRealtimeSessionOptions {
  accountKey: string;
  helperPath: string;
  storeDir: string;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  spawnImpl?: typeof spawn;
  onEvent?: (accountKey: string, event: WhatsAppHelperEventEnvelope) => void;
  onConnected?: (status: WhatsAppRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (status: WhatsAppRealtimeStatus) => void;
  onStatusChange?: (status: WhatsAppRealtimeStatus) => void;
}

export interface WhatsAppRealtimeSessionLike {
  start(): void;
  stop(): void;
  getStatus(): WhatsAppRealtimeStatus;
  isConnected(): boolean;
  sendText(target: string, text: string): Promise<WhatsAppHelperSendResult>;
  resync(): Promise<WhatsAppSnapshot>;
}

export interface WhatsAppRealtimeSupervisorSessionInput {
  accountKey: string;
  helperPath: string;
  storeDir: string;
}

interface WhatsAppRealtimeSupervisorOptions {
  createSession?: (input: WhatsAppRealtimeSupervisorSessionInput) => WhatsAppRealtimeSessionLike;
  onEvent?: (accountKey: string, event: WhatsAppHelperEventEnvelope) => void;
  onConnected?: (accountKey: string, status: WhatsAppRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (accountKey: string, status: WhatsAppRealtimeStatus) => void;
  onStatusChange?: (accountKey: string, status: WhatsAppRealtimeStatus) => void;
}

function now(): number {
  return Date.now();
}

function makeStatus(input: {
  accountKey: string;
  helperPath: string;
  storeDir: string;
  state?: WhatsAppRealtimeState;
  accountJid?: string | null;
  connectedAt?: number | null;
  lastEventAt?: number | null;
  lastHistorySyncAt?: number | null;
  lastReconnectAt?: number | null;
  reconnectAttempts?: number;
  lastSessionError?: string | null;
}): WhatsAppRealtimeStatus {
  return {
    platform: "whatsapp",
    accountKey: input.accountKey,
    helperPath: input.helperPath,
    storeDir: input.storeDir,
    state: input.state ?? "stopped",
    accountJid: input.accountJid ?? null,
    connectedAt: input.connectedAt ?? null,
    lastEventAt: input.lastEventAt ?? null,
    lastHistorySyncAt: input.lastHistorySyncAt ?? null,
    lastReconnectAt: input.lastReconnectAt ?? null,
    reconnectAttempts: input.reconnectAttempts ?? 0,
    lastSessionError: input.lastSessionError ?? null,
  };
}

function isResponseEnvelope(value: unknown): value is WhatsAppHelperResponseEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function isEventEnvelope(value: unknown): value is WhatsAppHelperEventEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string" &&
    "data" in (value as object)
  );
}

export function parseWhatsAppHelperLine(
  line: string,
): WhatsAppHelperEventEnvelope | WhatsAppHelperResponseEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isResponseEnvelope(parsed) || isEventEnvelope(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export class WhatsAppRealtimeSession implements WhatsAppRealtimeSessionLike {
  private readonly accountKey: string;
  private readonly helperPath: string;
  private readonly storeDir: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly onEvent?: (accountKey: string, event: WhatsAppHelperEventEnvelope) => void;
  private readonly onConnected?: (status: WhatsAppRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: WhatsAppRealtimeStatus) => void;
  private readonly onStatusChange?: (status: WhatsAppRealtimeStatus) => void;

  private child: ChildProcess | null = null;
  private readLine: ReadLineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private hasEverConnected = false;
  private status: WhatsAppRealtimeStatus;

  constructor(options: WhatsAppRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.helperPath = options.helperPath;
    this.storeDir = options.storeDir;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
      storeDir: this.storeDir,
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
    this.rejectPendingRequests("WhatsApp realtime session stopped");
    this.disposeChild();
    this.setStatus({
      state: "stopped",
      connectedAt: null,
      lastSessionError: null,
    });
  }

  getStatus(): WhatsAppRealtimeStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === "connected" && Boolean(this.child?.stdin?.writable);
  }

  async sendText(target: string, text: string): Promise<WhatsAppHelperSendResult> {
    const trimmedTarget = target.trim();
    const trimmedText = text.trim();
    if (!trimmedTarget || !trimmedText) {
      throw new Error("WhatsApp send requires a target and text");
    }

    const result = await this.request<WhatsAppHelperSendResult>({
      id: this.nextRequestId++,
      command: "sendText",
      target: trimmedTarget,
      text: trimmedText,
    });
    return result;
  }

  async resync(): Promise<WhatsAppSnapshot> {
    return await this.request<WhatsAppSnapshot>({
      id: this.nextRequestId++,
      command: "resync",
    });
  }

  private async request<TResult>(command: WhatsAppHelperCommand): Promise<TResult> {
    if (!this.child?.stdin?.writable || !this.isConnected()) {
      throw new Error("WhatsApp realtime session is not connected");
    }

    const payload = JSON.stringify(command) + "\n";
    return await new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(command.id);
        reject(new Error(`WhatsApp helper request timed out: ${command.command}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(command.id, {
        command: command.command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.child!.stdin!.write(payload, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pendingRequests.delete(command.id);
        reject(new Error(`Failed to write WhatsApp helper request: ${error.message}`));
      });
    });
  }

  private spawnChild(): void {
    this.disposeChild();
    const child = this.spawnImpl(this.helperPath, ["session", "--store-dir", this.storeDir], {
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
      whatsAppLogger.warn("realtime stderr", { accountKey: this.accountKey, message });
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
          ? `WhatsApp helper exited with code ${code}`
          : signal
            ? `WhatsApp helper exited with signal ${signal}`
            : "WhatsApp helper exited";
      this.handleExit(new Error(reason));
    });
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseWhatsAppHelperLine(line);
    if (!parsed) {
      return;
    }

    if (isResponseEnvelope(parsed)) {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(parsed.id);
      clearTimeout(pending.timeout);
      if (!parsed.ok) {
        pending.reject(
          new Error(parsed.error ?? `WhatsApp helper request failed: ${pending.command}`),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    const eventData = parsed.data as Record<string, unknown>;
    this.setStatus({
      lastEventAt: now(),
      lastSessionError:
        parsed.event === "error" && typeof eventData.message === "string"
          ? eventData.message
          : null,
    });
    if (parsed.event === "connected") {
      this.setStatus({
        accountJid: typeof eventData.accountJid === "string" ? eventData.accountJid : null,
        connectedAt: now(),
      });
    }
    if (parsed.event === "history_sync") {
      this.setStatus({
        lastHistorySyncAt:
          typeof eventData.completedAt === "number" ? eventData.completedAt : now(),
      });
    }
    if (parsed.event === "disconnected") {
      this.setStatus({
        state: this.shouldReconnect ? "reconnecting" : "degraded",
        connectedAt: null,
        lastSessionError: typeof eventData.reason === "string" ? eventData.reason : null,
      });
    }

    this.onEvent?.(this.accountKey, parsed);
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

  private setStatus(patch: Partial<WhatsAppRealtimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.onStatusChange?.(this.getStatus());
  }
}

type ManagedSession = {
  desired: WhatsAppRealtimeSupervisorSessionInput;
  session: WhatsAppRealtimeSessionLike;
};

export class WhatsAppRealtimeSupervisor {
  private readonly createSession: (
    input: WhatsAppRealtimeSupervisorSessionInput,
  ) => WhatsAppRealtimeSessionLike;
  private readonly onEvent?: WhatsAppRealtimeSupervisorOptions["onEvent"];
  private readonly onConnected?: WhatsAppRealtimeSupervisorOptions["onConnected"];
  private readonly onDisconnected?: WhatsAppRealtimeSupervisorOptions["onDisconnected"];
  private readonly onStatusChange?: WhatsAppRealtimeSupervisorOptions["onStatusChange"];
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly degradedStatuses = new Map<string, WhatsAppRealtimeStatus>();
  private readonly waiters = new Map<
    string,
    Array<{ resolve: (session: WhatsAppRealtimeSessionLike | null) => void; timer: NodeJS.Timeout }>
  >();

  constructor(options: WhatsAppRealtimeSupervisorOptions = {}) {
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.createSession =
      options.createSession ??
      ((input) =>
        new WhatsAppRealtimeSession({
          accountKey: input.accountKey,
          helperPath: input.helperPath,
          storeDir: input.storeDir,
          onEvent: (accountKey, event) => this.onEvent?.(accountKey, event),
          onConnected: (status, reconnected) => {
            this.resolveWaiters(
              input.accountKey,
              this.sessions.get(input.accountKey)?.session ?? null,
            );
            this.onConnected?.(input.accountKey, status, reconnected);
          },
          onDisconnected: (status) => this.onDisconnected?.(input.accountKey, status),
          onStatusChange: (status) => {
            this.degradedStatuses.delete(input.accountKey);
            this.onStatusChange?.(input.accountKey, status);
          },
        }));
  }

  reconcile(
    desiredInputs: WhatsAppRealtimeSupervisorSessionInput[],
    degradedInputs?: Array<Omit<WhatsAppRealtimeStatus, "platform">>,
  ): void {
    const desiredByKey = new Map(desiredInputs.map((input) => [input.accountKey, input]));
    for (const [accountKey, existing] of this.sessions) {
      const desired = desiredByKey.get(accountKey);
      if (!desired || !inputsEqual(existing.desired, desired)) {
        existing.session.stop();
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
      this.sessions.set(desired.accountKey, { desired, session });
      session.start();
    }

    this.degradedStatuses.clear();
    for (const degraded of degradedInputs ?? []) {
      this.degradedStatuses.set(degraded.accountKey, {
        platform: "whatsapp",
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

  getSession(accountKey: string): WhatsAppRealtimeSessionLike | null {
    return this.sessions.get(accountKey)?.session ?? null;
  }

  getStatuses(): WhatsAppRealtimeStatus[] {
    return [
      ...[...this.sessions.values()].map((managed) => managed.session.getStatus()),
      ...this.degradedStatuses.values(),
    ].sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  }

  async waitForConnected(
    accountKey: string,
    timeoutMs: number,
  ): Promise<WhatsAppRealtimeSessionLike | null> {
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

  private resolveWaiters(accountKey: string, session: WhatsAppRealtimeSessionLike | null): void {
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
}

function inputsEqual(
  left: WhatsAppRealtimeSupervisorSessionInput,
  right: WhatsAppRealtimeSupervisorSessionInput,
): boolean {
  return (
    left.accountKey === right.accountKey &&
    left.helperPath === right.helperPath &&
    left.storeDir === right.storeDir
  );
}
