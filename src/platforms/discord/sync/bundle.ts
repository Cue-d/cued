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
  } = {},
): Promise<SyncBundle> {
  const accountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const client = options.client ?? new DiscordApiClient(loadDiscordCredentials(accountKey));
  const syncMessageChannelLimit =
    options.syncMessageChannelLimit ?? DEFAULT_SYNC_MESSAGE_CHANNEL_LIMIT;
  const observedAt = Date.now();
  const currentUser = await client.getCurrentUser();
  const privateChannels = await client.listPrivateChannels();

  const rawEvents: SyncBundle["rawEvents"] = [];
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

  for (const channel of selectChannelsForMessageHydration(
    privateChannels,
    syncMessageChannelLimit,
  )) {
    try {
      const messages = await client.listChannelMessages(channel.id, { limit: 1 });
      const message = messages.at(0);
      if (!message) {
        continue;
      }
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
    } catch (error) {
      if (isDiscordAuthInvalidationError(error)) {
        throw error;
      }
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
  };
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
