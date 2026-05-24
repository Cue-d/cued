import type { SourceAccountInput } from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import {
  SignalCliClient as DefaultSignalCliClient,
  getSignalConfigDir,
  readSignalLinkedAccount,
  type SignalCliClient,
} from "../cli/client.js";
import { buildSignalRawEventsFromSnapshot } from "./events.js";

type SignalClientLike = Pick<SignalCliClient, "listContacts" | "listGroups" | "receiveMessages">;

export async function buildSignalSyncBundle(options?: {
  accountKey?: string;
  account?: string;
  lastSyncAt?: number;
  client?: SignalClientLike;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? "default";
  const configDir = getSignalConfigDir(accountKey);
  const account = options?.account ?? readSignalLinkedAccount(configDir);
  if (!account) {
    throw new Error(`Signal account is not linked for '${accountKey}'`);
  }

  const client =
    options?.client ??
    new DefaultSignalCliClient({
      account,
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
