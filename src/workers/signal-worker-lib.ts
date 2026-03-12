import type { SyncBundle } from "../adapters/types.js";
import {
  SignalCliClient as DefaultSignalCliClient,
  getSignalConfigDir,
  readSignalLinkedAccount,
  type SignalCliClient,
} from "../integrations/signal-cli.js";
import { buildSignalRawEventsFromSnapshot } from "../integrations/signal-events.js";
import type { SourceAccountInput } from "../types/provider.js";

type SignalClientLike = Pick<SignalCliClient, "listContacts" | "listGroups" | "receiveMessages">;

export async function buildSignalSyncBundle(options?: {
  accountKey?: string;
  account?: string;
  lastSyncAt?: number;
  client?: SignalClientLike;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const configDir = getSignalConfigDir(accountKey);
  const account =
    options?.account ?? process.env.CUED_SIGNAL_ACCOUNT ?? readSignalLinkedAccount(configDir);
  if (!account) {
    throw new Error(`Signal account is not linked for '${accountKey}'`);
  }

  const client =
    options?.client ??
    new DefaultSignalCliClient({
      account,
      cliPath: process.env.CUED_SIGNAL_CLI_PATH,
      configDir,
    });

  const observedBase = Date.now();
  const sourceAccounts: SourceAccountInput[] = [
    {
      platform: "signal",
      accountKey,
      displayName: "Signal",
    },
  ];

  const contacts = await client.listContacts();
  const groups = await client.listGroups().catch(() => []);
  const messages = await client.receiveMessages();

  return {
    sourceAccounts,
    rawEvents: buildSignalRawEventsFromSnapshot({
      accountKey,
      contacts,
      groups,
      messages,
      observedBase,
    }),
    sourceCursor: {
      account,
      lastSyncAt: observedBase,
    },
    syncMode: options?.lastSyncAt ? "incremental" : "full",
    hasMore: false,
  };
}
