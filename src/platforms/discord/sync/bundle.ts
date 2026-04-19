import type { SourceAccountInput } from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import { DiscordApiClient, isDiscordAuthInvalidationError } from "../api/client.js";
import type { DiscordStoredCredentials, DiscordUser } from "../types.js";
import { discordDisplayName, isDiscordDmChannel } from "../types.js";
import {
  buildDiscordContactEvent,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "./events.js";

const DEFAULT_SYNC_MESSAGE_CHANNEL_LIMIT = 5;
const DEFAULT_SYNC_MESSAGES_PER_CHANNEL_LIMIT = 50;

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
  } = {},
): Promise<SyncBundle> {
  const accountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const client = options.client ?? new DiscordApiClient(loadDiscordCredentials(accountKey));
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

  for (const channel of hydrationChannels) {
    attemptedHydrationChannelCount += 1;
    try {
      const messages = await client.listChannelMessages(channel.id, {
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
    },
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
  limit: number,
) {
  return channels
    .filter((channel) => isDiscordDmChannel(channel) && typeof channel.last_message_id === "string")
    .sort((left, right) =>
      compareDiscordSnowflakesDesc(left.last_message_id!, right.last_message_id!),
    )
    .slice(0, Math.max(0, limit));
}

function compareDiscordSnowflakesDesc(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId === rightId) {
    return 0;
  }
  return leftId > rightId ? -1 : 1;
}
