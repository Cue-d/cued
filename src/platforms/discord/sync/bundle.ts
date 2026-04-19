import type { SourceAccountInput } from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import { DiscordApiClient, isDiscordAuthInvalidationError } from "../api/client.js";
import type { DiscordMessage, DiscordStoredCredentials, DiscordUser } from "../types.js";
import { discordDisplayName, isDiscordDmChannel } from "../types.js";
import {
  buildDiscordContactEvent,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "./events.js";

const DEFAULT_SYNC_MESSAGE_CHANNEL_LIMIT = 5;
const DEFAULT_SYNC_MESSAGES_PER_CHANNEL_LIMIT = 50;
const DISCORD_INCREMENTAL_PAGE_LIMIT = 100;

type DiscordHydrationDiagnostics = {
  selectedChannelCount: number;
  attemptedChannelCount: number;
  completedChannelCount: number;
  messageLimitPerChannel: number;
  partial: boolean;
  breakChannelId: string | null;
  error: string | null;
  rateLimited: boolean;
};

type DiscordSyncCursor = {
  userId: string | null;
  discoveredAt: number | null;
  lastSyncAt: number | null;
  channels: Record<
    string,
    {
      latestMessageId: string | null;
    }
  >;
};

function loadDiscordCredentials(accountKey: string): DiscordStoredCredentials {
  const parsed = loadIntegrationSecret("discord", accountKey).secret;
  if (
    typeof parsed.token !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.username !== "string" ||
    typeof parsed.savedAt !== "number"
  ) {
    throw new Error(`Discord Keychain payload for '${accountKey}' is incomplete`);
  }
  return {
    token: parsed.token,
    savedAt: parsed.savedAt,
    userId: parsed.userId,
    username: parsed.username,
    globalName: typeof parsed.globalName === "string" ? parsed.globalName : null,
  };
}

export async function buildDiscordSyncBundle(
  input: { accountKey?: string } = {},
  options: {
    client?: DiscordApiClient;
    syncMessageChannelLimit?: number;
    syncMessagesPerChannelLimit?: number;
    sourceCursor?: unknown;
  } = {},
): Promise<SyncBundle> {
  const accountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const client = options.client ?? new DiscordApiClient(loadDiscordCredentials(accountKey));
  const sourceCursor = parseDiscordSyncCursor(
    options.sourceCursor ??
      (typeof process.env.CUED_DISCORD_SOURCE_CURSOR === "string"
        ? JSON.parse(process.env.CUED_DISCORD_SOURCE_CURSOR)
        : null),
  );
  const syncMessageChannelLimit =
    options.syncMessageChannelLimit ?? getDiscordSyncMessageChannelLimit();
  const syncMessagesPerChannelLimit =
    options.syncMessagesPerChannelLimit ?? getDiscordSyncMessagesPerChannelLimit();
  const observedAt = Date.now();
  const currentUser = await client.getCurrentUser();
  const privateChannels = await client.listPrivateChannels();

  const rawEvents: SyncBundle["rawEvents"] = [];
  const hydrationChannels = selectChannelsForMessageHydration(
    privateChannels,
    sourceCursor,
    syncMessageChannelLimit,
  );
  let attemptedHydrationChannelCount = 0;
  let completedHydrationChannelCount = 0;
  let hydrationBreakChannelId: string | null = null;
  let hydrationErrorMessage: string | null = null;
  const seenContacts = new Set<string>();
  const pushContact = (user: DiscordUser, displayName?: string | null) => {
    const event = buildDiscordContactEvent({
      accountKey,
      observedAt,
      user,
      displayName,
    });
    if (seenContacts.has(event.id)) {
      return;
    }
    seenContacts.add(event.id);
    rawEvents.push(event);
  };

  pushContact(currentUser);

  for (const channel of privateChannels.filter(isDiscordDmChannel)) {
    for (const recipient of channel.recipients ?? []) {
      pushContact(recipient);
    }
    rawEvents.push(
      buildDiscordConversationEvent({
        accountKey,
        observedAt,
        channel,
        currentUser,
        guildNameById: new Map(),
      }),
    );
  }

  const nextChannelCursor = buildDiscordChannelCursor(privateChannels);
  for (const channel of hydrationChannels) {
    attemptedHydrationChannelCount += 1;
    try {
      const previousLatestMessageId =
        sourceCursor.channels[channel.id]?.latestMessageId?.trim() || null;
      const messages = previousLatestMessageId
        ? await listDiscordMessagesSince(client, channel.id, previousLatestMessageId)
        : await client.listChannelMessages(channel.id, {
            limit: syncMessagesPerChannelLimit,
          });
      completedHydrationChannelCount += 1;
      if (messages.length === 0) {
        continue;
      }
      for (const message of [...messages].reverse()) {
        pushContact(message.author, message.member?.nick ?? null);
        rawEvents.push(
          buildDiscordMessageEvent({
            accountKey,
            observedAt,
            channel,
            message,
            currentUserId: currentUser.id,
          }),
        );
      }
    } catch (error) {
      if (isDiscordAuthInvalidationError(error)) {
        throw error;
      }
      hydrationBreakChannelId = channel.id;
      hydrationErrorMessage = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const sourceAccounts: SourceAccountInput[] = [
    {
      platform: "discord",
      accountKey,
      displayName: discordDisplayName(currentUser),
    },
  ];

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor: {
      userId: currentUser.id,
      discoveredAt: observedAt,
      lastSyncAt: observedAt,
      channels: nextChannelCursor,
    } satisfies DiscordSyncCursor,
    syncMode: "incremental",
    hasMore: false,
    diagnostics: {
      discordHydration: buildDiscordHydrationDiagnostics({
        selectedChannelCount: hydrationChannels.length,
        attemptedChannelCount: attemptedHydrationChannelCount,
        completedChannelCount: completedHydrationChannelCount,
        messageLimitPerChannel: syncMessagesPerChannelLimit,
        breakChannelId: hydrationBreakChannelId,
        error: hydrationErrorMessage,
      }),
    },
  };
}

function buildDiscordHydrationDiagnostics(input: {
  selectedChannelCount: number;
  attemptedChannelCount: number;
  completedChannelCount: number;
  messageLimitPerChannel: number;
  breakChannelId: string | null;
  error: string | null;
}): DiscordHydrationDiagnostics {
  const error = input.error?.trim() || null;
  return {
    selectedChannelCount: input.selectedChannelCount,
    attemptedChannelCount: input.attemptedChannelCount,
    completedChannelCount: input.completedChannelCount,
    messageLimitPerChannel: input.messageLimitPerChannel,
    partial: error !== null,
    breakChannelId: input.breakChannelId,
    error,
    rateLimited: error?.toLowerCase().includes("rate limited") ?? false,
  };
}

export function getDiscordSyncMessageChannelLimit(): number {
  return parsePositiveInteger(
    process.env.CUED_DISCORD_SYNC_MESSAGE_CHANNEL_LIMIT,
    DEFAULT_SYNC_MESSAGE_CHANNEL_LIMIT,
  );
}

export function getDiscordSyncMessagesPerChannelLimit(): number {
  return parsePositiveInteger(
    process.env.CUED_DISCORD_SYNC_MESSAGES_PER_CHANNEL_LIMIT,
    DEFAULT_SYNC_MESSAGES_PER_CHANNEL_LIMIT,
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function selectChannelsForMessageHydration(
  channels: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>,
  sourceCursor: DiscordSyncCursor,
  limit: number,
) {
  const dmChannels = channels.filter(
    (channel) => isDiscordDmChannel(channel) && typeof channel.last_message_id === "string",
  );
  const sorted = dmChannels.sort((left, right) =>
    compareDiscordSnowflakesDesc(left.last_message_id!, right.last_message_id!),
  );
  const changedChannels = sorted.filter((channel) => {
    const latestMessageId = sourceCursor.channels[channel.id]?.latestMessageId ?? null;
    return latestMessageId && isSnowflakeGreater(channel.last_message_id!, latestMessageId);
  });
  const initialChannels = sorted
    .filter((channel) => !sourceCursor.channels[channel.id]?.latestMessageId)
    .slice(0, Math.max(0, limit));

  const selected = new Map<string, (typeof sorted)[number]>();
  for (const channel of changedChannels) {
    selected.set(channel.id, channel);
  }
  for (const channel of initialChannels) {
    selected.set(channel.id, channel);
  }
  return [...selected.values()];
}

function compareDiscordSnowflakesDesc(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId === rightId) {
    return 0;
  }
  return leftId > rightId ? -1 : 1;
}

function isSnowflakeGreater(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function parseDiscordSyncCursor(value: unknown): DiscordSyncCursor {
  const cursor = isRecord(value) ? value : null;
  const channels = isRecord(cursor?.channels) ? cursor.channels : null;
  return {
    userId: typeof cursor?.userId === "string" ? cursor.userId : null,
    discoveredAt: typeof cursor?.discoveredAt === "number" ? cursor.discoveredAt : null,
    lastSyncAt: typeof cursor?.lastSyncAt === "number" ? cursor.lastSyncAt : null,
    channels: Object.fromEntries(
      Object.entries(channels ?? {}).map(([channelId, channelCursor]) => [
        channelId,
        {
          latestMessageId:
            isRecord(channelCursor) && typeof channelCursor.latestMessageId === "string"
              ? channelCursor.latestMessageId
              : null,
        },
      ]),
    ),
  };
}

function buildDiscordChannelCursor(
  channels: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>,
): DiscordSyncCursor["channels"] {
  return Object.fromEntries(
    channels.filter(isDiscordDmChannel).map((channel) => [
      channel.id,
      {
        latestMessageId:
          typeof channel.last_message_id === "string" ? channel.last_message_id : null,
      },
    ]),
  );
}

async function listDiscordMessagesSince(
  client: DiscordApiClient,
  channelId: string,
  latestMessageId: string,
): Promise<DiscordMessage[]> {
  const collected: DiscordMessage[] = [];
  let before: string | null = null;

  while (true) {
    const page = await client.listChannelMessages(channelId, {
      before,
      limit: DISCORD_INCREMENTAL_PAGE_LIMIT,
    });
    if (page.length === 0) {
      break;
    }

    const newerMessages = page.filter((message) => isSnowflakeGreater(message.id, latestMessageId));
    collected.push(...newerMessages);

    const oldestPageMessageId = page.at(-1)?.id ?? null;
    const reachedCursor = newerMessages.length !== page.length;
    if (reachedCursor || page.length < DISCORD_INCREMENTAL_PAGE_LIMIT || !oldestPageMessageId) {
      break;
    }

    before = oldestPageMessageId;
  }

  return collected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
