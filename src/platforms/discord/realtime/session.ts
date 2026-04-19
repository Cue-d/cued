import { DiscordApiClient, isDiscordAuthInvalidationError } from "../api/client.js";
import {
  type DiscordChannel,
  type DiscordMessage,
  type DiscordStoredCredentials,
  type DiscordUser,
  discordDisplayName,
  isDiscordDmChannel,
} from "../types.js";

const DEFAULT_DM_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
export type DiscordRealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "stopped";

export interface DiscordRealtimeStatus {
  platform: "discord";
  accountKey: string;
  state: DiscordRealtimeState;
  userId: string | null;
  username: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  lastReconnectAt: number | null;
  reconnectAttempts: number;
  lastSessionError: string | null;
}

export type DiscordRealtimeEventEnvelope =
  | {
      event: "contact_upsert";
      data: {
        user: DiscordUser;
        displayName?: string | null;
      };
    }
  | {
      event: "conversation_upsert";
      data: {
        channel: DiscordChannel;
        currentUser: DiscordUser;
        guildNameById: Map<string, string>;
        isNew: boolean;
      };
    }
  | {
      event: "message_upsert";
      data: {
        channel: DiscordChannel;
        currentUserId: string;
        message: DiscordMessage;
      };
    };

export interface DiscordRealtimeSessionLike {
  start(): void;
  stop(): void;
  getStatus(): DiscordRealtimeStatus;
  isConnected(): boolean;
  sendMessage(
    channelId: string,
    text: string,
    options?: { replyToMessageId?: string | null },
  ): Promise<DiscordMessage>;
}

export interface DiscordRealtimeSupervisorSessionInput {
  accountKey: string;
  credentials: Pick<DiscordStoredCredentials, "token">;
  dmPollIntervalMs?: number;
}

interface DiscordRealtimeSessionOptions extends DiscordRealtimeSupervisorSessionInput {
  client?: DiscordApiClient;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onEvent?: (accountKey: string, event: DiscordRealtimeEventEnvelope) => void;
  onConnected?: (status: DiscordRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (status: DiscordRealtimeStatus) => void;
  onStatusChange?: (status: DiscordRealtimeStatus) => void;
  onAuthInvalidated?: (status: DiscordRealtimeStatus, reason: string) => void;
}

interface DiscordRealtimeSupervisorOptions {
  createSession?: (input: DiscordRealtimeSupervisorSessionInput) => DiscordRealtimeSessionLike;
  onEvent?: (accountKey: string, event: DiscordRealtimeEventEnvelope) => void;
  onConnected?: (accountKey: string, status: DiscordRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (accountKey: string, status: DiscordRealtimeStatus) => void;
  onStatusChange?: (accountKey: string, status: DiscordRealtimeStatus) => void;
  onAuthInvalidated?: (accountKey: string, status: DiscordRealtimeStatus, reason: string) => void;
}

type ManagedDiscordSession = {
  desired: DiscordRealtimeSupervisorSessionInput;
  session: DiscordRealtimeSessionLike;
};

function now(): number {
  return Date.now();
}

function makeStatus(input: {
  accountKey: string;
  state?: DiscordRealtimeState;
  userId?: string | null;
  username?: string | null;
  connectedAt?: number | null;
  lastEventAt?: number | null;
  lastReconnectAt?: number | null;
  reconnectAttempts?: number;
  lastSessionError?: string | null;
}): DiscordRealtimeStatus {
  return {
    platform: "discord",
    accountKey: input.accountKey,
    state: input.state ?? "stopped",
    userId: input.userId ?? null,
    username: input.username ?? null,
    connectedAt: input.connectedAt ?? null,
    lastEventAt: input.lastEventAt ?? null,
    lastReconnectAt: input.lastReconnectAt ?? null,
    reconnectAttempts: input.reconnectAttempts ?? 0,
    lastSessionError: input.lastSessionError ?? null,
  };
}

export class DiscordRealtimeSession implements DiscordRealtimeSessionLike {
  private readonly client: DiscordApiClient;
  private readonly accountKey: string;
  private readonly dmPollIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onEvent?: (accountKey: string, event: DiscordRealtimeEventEnvelope) => void;
  private readonly onConnected?: (status: DiscordRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: DiscordRealtimeStatus) => void;
  private readonly onStatusChange?: (status: DiscordRealtimeStatus) => void;
  private readonly onAuthInvalidated?: (status: DiscordRealtimeStatus, reason: string) => void;

  private shouldReconnect = false;
  private hasEverConnected = false;
  private dmPollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollingDm = false;
  private currentUser: DiscordUser | null = null;
  private channelById = new Map<string, DiscordChannel>();
  private lastMessageIdByChannel = new Map<string, string | null>();
  private status: DiscordRealtimeStatus;

  constructor(options: DiscordRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.client = options.client ?? new DiscordApiClient(options.credentials);
    this.dmPollIntervalMs = options.dmPollIntervalMs ?? DEFAULT_DM_POLL_INTERVAL_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.onAuthInvalidated = options.onAuthInvalidated;
    this.status = makeStatus({ accountKey: this.accountKey });
  }

  start(): void {
    if (this.shouldReconnect) {
      return;
    }
    this.shouldReconnect = true;
    this.setStatus({
      state: this.hasEverConnected ? "reconnecting" : "connecting",
      lastSessionError: null,
    });
    void this.bootstrap();
  }

  stop(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    this.currentUser = null;
    this.channelById.clear();
    this.lastMessageIdByChannel.clear();
    this.setStatus({
      state: "stopped",
      connectedAt: null,
      lastSessionError: null,
    });
  }

  getStatus(): DiscordRealtimeStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === "connected";
  }

  async sendMessage(
    channelId: string,
    text: string,
    options: { replyToMessageId?: string | null } = {},
  ): Promise<DiscordMessage> {
    return await this.client.sendMessage(channelId, text, options);
  }

  private async bootstrap(): Promise<void> {
    try {
      const reconnected = this.hasEverConnected;
      const currentUser = await this.client.getCurrentUser();
      this.currentUser = currentUser;
      this.emitEvent({
        event: "contact_upsert",
        data: {
          user: currentUser,
        },
      });
      await this.refreshDmChannels({ seedOnly: false });
      this.hasEverConnected = true;
      this.setStatus({
        state: "connected",
        userId: currentUser.id,
        username: discordDisplayName(currentUser),
        connectedAt: this.status.connectedAt ?? now(),
        lastSessionError: null,
      });
      this.onConnected?.(this.getStatus(), reconnected);
      this.scheduleTimers();
    } catch (error) {
      this.handlePollFailure(error);
    }
  }

  private scheduleTimers(): void {
    this.clearTimers();
    this.dmPollTimer = setInterval(() => {
      void this.refreshDmChannels({ seedOnly: false });
    }, this.dmPollIntervalMs);
  }

  private clearTimers(): void {
    if (this.dmPollTimer) {
      clearInterval(this.dmPollTimer);
      this.dmPollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async refreshDmChannels(input: { seedOnly: boolean }): Promise<void> {
    if (!this.currentUser || this.pollingDm) {
      return;
    }
    this.pollingDm = true;
    try {
      const channels = (await this.client.listPrivateChannels()).filter(isDiscordDmChannel);
      await this.refreshChannels(channels, input.seedOnly);
    } catch (error) {
      this.handlePollFailure(error);
    } finally {
      this.pollingDm = false;
    }
  }

  private async refreshChannels(channels: DiscordChannel[], seedOnly: boolean): Promise<void> {
    const currentUser = this.currentUser;
    if (!currentUser) {
      return;
    }

    for (const channel of channels) {
      const existing = this.channelById.get(channel.id);
      const isNew = !existing;
      this.channelById.set(channel.id, channel);
      if (isNew || hasMeaningfulChannelChange(existing, channel)) {
        if (!seedOnly) {
          this.emitEvent({
            event: "conversation_upsert",
            data: {
              channel,
              currentUser,
              guildNameById: new Map(),
              isNew,
            },
          });
          for (const recipient of channel.recipients ?? []) {
            this.emitEvent({
              event: "contact_upsert",
              data: {
                user: recipient,
              },
            });
          }
        }
      }

      const previousLastMessageId = this.lastMessageIdByChannel.get(channel.id);
      const nextLastMessageId = channel.last_message_id ?? null;
      if (!this.lastMessageIdByChannel.has(channel.id)) {
        this.lastMessageIdByChannel.set(channel.id, nextLastMessageId);
        continue;
      }
      if (previousLastMessageId === nextLastMessageId) {
        continue;
      }
      this.lastMessageIdByChannel.set(channel.id, nextLastMessageId);
      if (seedOnly || !nextLastMessageId) {
        continue;
      }
      const messages = await this.loadNewMessagesForChannel({
        channelId: channel.id,
        previousLastMessageId,
        nextLastMessageId,
      });
      for (const message of messages) {
        this.emitEvent({
          event: "contact_upsert",
          data: {
            user: message.author,
            displayName: message.member?.nick ?? null,
          },
        });
        this.emitEvent({
          event: "message_upsert",
          data: {
            channel,
            currentUserId: currentUser.id,
            message,
          },
        });
      }
    }
  }

  private async loadNewMessagesForChannel(input: {
    channelId: string;
    previousLastMessageId: string | null | undefined;
    nextLastMessageId: string;
  }): Promise<DiscordMessage[]> {
    const messages = await this.client.listChannelMessages(input.channelId, {
      after: input.previousLastMessageId ?? undefined,
      limit: 50,
    });

    if (!input.previousLastMessageId) {
      return messages.filter((message) => message.id === input.nextLastMessageId);
    }

    return messages.sort(compareDiscordMessagesAscending);
  }

  private emitEvent(event: DiscordRealtimeEventEnvelope): void {
    this.setStatus({ lastEventAt: now() });
    this.onEvent?.(this.accountKey, event);
  }

  private handlePollFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.clearTimers();
    this.onDisconnected?.(this.getStatus());
    if (isDiscordAuthInvalidationError(error)) {
      this.shouldReconnect = false;
      this.setStatus({
        state: "stopped",
        lastSessionError: message,
        lastReconnectAt: now(),
        reconnectAttempts: this.status.reconnectAttempts + 1,
      });
      this.onAuthInvalidated?.(this.getStatus(), message);
      return;
    }
    this.setStatus({
      state: "degraded",
      lastSessionError: message,
      lastReconnectAt: now(),
      reconnectAttempts: this.status.reconnectAttempts + 1,
    });
    if (!this.shouldReconnect) {
      return;
    }
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.max(0, this.status.reconnectAttempts),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) {
        return;
      }
      this.setStatus({
        state: "reconnecting",
        lastSessionError: null,
      });
      void this.bootstrap();
    }, delayMs);
  }

  private setStatus(next: Partial<Omit<DiscordRealtimeStatus, "platform" | "accountKey">>): void {
    this.status = {
      ...this.status,
      ...next,
    };
    this.onStatusChange?.(this.getStatus());
  }
}

function compareDiscordMessagesAscending(
  a: Pick<DiscordMessage, "id">,
  b: Pick<DiscordMessage, "id">,
): number {
  const aId = BigInt(a.id);
  const bId = BigInt(b.id);
  if (aId === bId) {
    return 0;
  }
  return aId < bId ? -1 : 1;
}

export class DiscordRealtimeSupervisor {
  private readonly createSession: (
    input: DiscordRealtimeSupervisorSessionInput,
  ) => DiscordRealtimeSessionLike;
  private readonly onEvent?: DiscordRealtimeSupervisorOptions["onEvent"];
  private readonly onConnected?: DiscordRealtimeSupervisorOptions["onConnected"];
  private readonly onDisconnected?: DiscordRealtimeSupervisorOptions["onDisconnected"];
  private readonly onStatusChange?: DiscordRealtimeSupervisorOptions["onStatusChange"];
  private readonly onAuthInvalidated?: DiscordRealtimeSupervisorOptions["onAuthInvalidated"];
  private readonly sessions = new Map<string, ManagedDiscordSession>();
  private readonly degradedStatuses = new Map<string, DiscordRealtimeStatus>();

  constructor(options: DiscordRealtimeSupervisorOptions = {}) {
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.onAuthInvalidated = options.onAuthInvalidated;
    this.createSession =
      options.createSession ??
      ((input) =>
        new DiscordRealtimeSession({
          ...input,
          onEvent: (accountKey, event) => this.onEvent?.(accountKey, event),
          onConnected: (status, reconnected) =>
            this.onConnected?.(input.accountKey, status, reconnected),
          onDisconnected: (status) => this.onDisconnected?.(input.accountKey, status),
          onStatusChange: (status) => {
            this.degradedStatuses.delete(input.accountKey);
            this.onStatusChange?.(input.accountKey, status);
          },
          onAuthInvalidated: (status, reason) => {
            this.degradedStatuses.delete(input.accountKey);
            this.onAuthInvalidated?.(input.accountKey, status, reason);
          },
        }));
  }

  reconcile(
    desiredInputs: DiscordRealtimeSupervisorSessionInput[],
    degradedInputs?: Array<Omit<DiscordRealtimeStatus, "platform">>,
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
        platform: "discord",
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

  getSession(accountKey: string): DiscordRealtimeSessionLike | null {
    return this.sessions.get(accountKey)?.session ?? null;
  }

  getStatuses(): DiscordRealtimeStatus[] {
    return [
      ...[...this.sessions.values()].map((managed) => managed.session.getStatus()),
      ...this.degradedStatuses.values(),
    ].sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  }
}

function sameDesiredSession(
  left: DiscordRealtimeSupervisorSessionInput,
  right: DiscordRealtimeSupervisorSessionInput,
): boolean {
  return (
    left.accountKey === right.accountKey &&
    left.credentials.token === right.credentials.token &&
    (left.dmPollIntervalMs ?? DEFAULT_DM_POLL_INTERVAL_MS) ===
      (right.dmPollIntervalMs ?? DEFAULT_DM_POLL_INTERVAL_MS)
  );
}

function hasMeaningfulChannelChange(
  left: DiscordChannel | undefined,
  right: DiscordChannel,
): boolean {
  if (!left) {
    return true;
  }
  return (
    left.name !== right.name ||
    left.topic !== right.topic ||
    left.parent_id !== right.parent_id ||
    left.guild_id !== right.guild_id ||
    JSON.stringify(left.recipients ?? []) !== JSON.stringify(right.recipients ?? [])
  );
}
