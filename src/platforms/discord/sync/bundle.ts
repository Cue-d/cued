import type { SourceAccountInput } from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import { DiscordApiClient } from "../api/client.js";
import type { DiscordStoredCredentials, DiscordUser } from "../types.js";
import { discordDisplayName, isDiscordDmChannel } from "../types.js";
import { buildDiscordContactEvent, buildDiscordConversationEvent } from "./events.js";

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
): Promise<SyncBundle> {
  const accountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const credentials = loadDiscordCredentials(accountKey);
  const client = new DiscordApiClient(credentials);
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
