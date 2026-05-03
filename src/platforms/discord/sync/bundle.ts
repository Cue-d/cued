import type { SourceAccountInput, SyncProofInput } from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import {
  DiscordApiClient,
  getDiscordRetryAfterMs,
  isDiscordAuthInvalidationError,
  isDiscordRateLimitError,
} from "../api/client.js";
import type { DiscordMessage, DiscordStoredCredentials, DiscordUser } from "../types.js";
import { discordDisplayName, isDiscordDmChannel } from "../types.js";
import {
  buildDiscordContactEvent,
  buildDiscordConversationDisplayName,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "./events.js";

const DEFAULT_SYNC_MESSAGE_CHANNEL_LIMIT = 5;
const DEFAULT_SYNC_MESSAGES_PER_CHANNEL_LIMIT = 50;
const DEFAULT_SYNC_BACKFILL_PAGE_LIMIT = 2;
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
  retryAfterMs: number | null;
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

type DiscordHydratedChannel = {
  channelId: string;
  messages: DiscordMessage[];
  previousLatestMessageId: string | null;
};

type DiscordProofSnapshot = {
  scopeKey: string;
  proofKind: string;
  status: string;
  resumeCursor: Record<string, unknown> | null;
  coverage: Record<string, unknown> | null;
  lastObservedAt: number | null;
};

type DiscordProofState = {
  latestMessages: Map<string, DiscordProofSnapshot>;
  messages: Map<string, DiscordProofSnapshot>;
};

type DiscordHydrationTarget = {
  channel: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>[number];
  previousLatestMessageId: string | null;
};

type DiscordBackfillTarget = {
  channel: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>[number];
  before: string;
  coverage: Record<string, unknown> | null;
  lastObservedAt: number | null;
};

type DiscordBackfilledChannel = {
  channelId: string;
  messages: DiscordMessage[];
  previousBefore: string;
  nextBefore: string | null;
  historyComplete: boolean;
  coverage: Record<string, unknown> | null;
  error: string | null;
  rateLimited: boolean;
  retryAfterMs: number | null;
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
    syncProofs?: unknown;
    backfillPageLimit?: number;
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
  const syncProofState = parseDiscordProofState(
    options.syncProofs ??
      (typeof process.env.CUED_DISCORD_SYNC_PROOFS === "string"
        ? JSON.parse(process.env.CUED_DISCORD_SYNC_PROOFS)
        : null),
  );
  const syncMessageChannelLimit =
    options.syncMessageChannelLimit ?? getDiscordSyncMessageChannelLimit();
  const syncMessagesPerChannelLimit =
    options.syncMessagesPerChannelLimit ?? getDiscordSyncMessagesPerChannelLimit();
  const backfillPageLimit = options.backfillPageLimit ?? getDiscordSyncBackfillPageLimit();
  const observedAt = Date.now();
  const currentUser = await client.getCurrentUser();
  const privateChannels = await client.listPrivateChannels();
  const privateDmChannels = privateChannels.filter(isDiscordDmChannel);

  const rawEvents: SyncBundle["rawEvents"] = [];
  const hydrationChannels = selectChannelsForMessageHydration(
    privateChannels,
    sourceCursor,
    syncProofState,
    syncMessageChannelLimit,
  );
  const backfillTargets = selectBackfillTargets(
    privateDmChannels,
    syncProofState,
    backfillPageLimit,
  );
  let attemptedHydrationChannelCount = 0;
  let completedHydrationChannelCount = 0;
  let hydrationBreakChannelId: string | null = null;
  let hydrationErrorMessage: string | null = null;
  let hydrationRetryAfterMs: number | null = null;
  let attemptedBackfillChannelCount = 0;
  let completedBackfillChannelCount = 0;
  let backfillBreakChannelId: string | null = null;
  let backfillErrorMessage: string | null = null;
  let backfillRetryAfterMs: number | null = null;
  const hydratedChannels: DiscordHydratedChannel[] = [];
  const backfilledChannels: DiscordBackfilledChannel[] = [];
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

  for (const channel of privateDmChannels) {
    for (const recipient of channel.recipients ?? []) {
      pushContact(recipient);
    }
    rawEvents.push(
      buildDiscordConversationEvent({
        accountKey,
        observedAt,
        channel,
        currentUser,
      }),
    );
  }

  const nextChannelCursor = buildDiscordChannelCursor(privateChannels);
  for (const target of hydrationChannels) {
    const channel = target.channel;
    attemptedHydrationChannelCount += 1;
    try {
      const messages = target.previousLatestMessageId
        ? await listDiscordMessagesSince(client, channel.id, target.previousLatestMessageId)
        : await client.listChannelMessages(channel.id, {
            limit: syncMessagesPerChannelLimit,
          });
      completedHydrationChannelCount += 1;
      hydratedChannels.push({
        channelId: channel.id,
        messages,
        previousLatestMessageId: target.previousLatestMessageId,
      });
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
      hydrationRetryAfterMs = getDiscordRetryAfterMs(error);
      break;
    }
  }

  for (const target of backfillTargets) {
    attemptedBackfillChannelCount += 1;
    try {
      const page = await client.listChannelMessages(target.channel.id, {
        before: target.before,
        limit: DISCORD_INCREMENTAL_PAGE_LIMIT,
      });
      const oldestPageMessageId = getOldestDiscordMessageId(page);
      const historyComplete = page.length < DISCORD_INCREMENTAL_PAGE_LIMIT;
      const cursorAdvanced =
        historyComplete ||
        (oldestPageMessageId != null &&
          isDiscordMessageIdBefore(oldestPageMessageId, target.before));
      if (!cursorAdvanced) {
        backfillBreakChannelId = target.channel.id;
        backfillErrorMessage = `Discord backfill cursor did not advance before '${target.before}'`;
        backfilledChannels.push({
          channelId: target.channel.id,
          messages: [],
          previousBefore: target.before,
          nextBefore: target.before,
          historyComplete: false,
          coverage: target.coverage,
          error: backfillErrorMessage,
          rateLimited: false,
          retryAfterMs: null,
        });
        break;
      }
      completedBackfillChannelCount += 1;
      backfilledChannels.push({
        channelId: target.channel.id,
        messages: page,
        previousBefore: target.before,
        nextBefore: historyComplete ? null : oldestPageMessageId,
        historyComplete,
        coverage: target.coverage,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      });
      for (const message of [...page].reverse()) {
        pushContact(message.author, message.member?.nick ?? null);
        rawEvents.push(
          buildDiscordMessageEvent({
            accountKey,
            observedAt,
            channel: target.channel,
            message,
            currentUserId: currentUser.id,
          }),
        );
      }
    } catch (error) {
      if (isDiscordAuthInvalidationError(error)) {
        throw error;
      }
      backfillBreakChannelId = target.channel.id;
      backfillErrorMessage = error instanceof Error ? error.message : String(error);
      backfillRetryAfterMs = getDiscordRetryAfterMs(error);
      backfilledChannels.push({
        channelId: target.channel.id,
        messages: [],
        previousBefore: target.before,
        nextBefore: target.before,
        historyComplete: false,
        coverage: target.coverage,
        error: backfillErrorMessage,
        rateLimited: isDiscordRateLimitError(error),
        retryAfterMs: backfillRetryAfterMs,
      });
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
  const proofs = buildDiscordSyncProofs({
    accountKey,
    observedAt,
    currentUser,
    channels: privateDmChannels,
    sourceCursor,
    hydratedChannels,
    backfilledChannels,
    nextChannelCursor,
    syncMessagesPerChannelLimit,
    hydrationError: hydrationErrorMessage,
    hydrationBreakChannelId,
    hydrationRetryAfterMs,
  });
  const hasMore = hasRunningDiscordMessageProof(proofs);
  const firstRunningMessageProof = proofs.find(
    (proof) => proof.proofKind === "messages" && proof.status === "running",
  );

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
    hasMore,
    continuation: hasMore
      ? {
          reason:
            hydrationRetryAfterMs != null || backfillRetryAfterMs != null
              ? "rate_limit_backoff"
              : "scoped_proof_continuation",
          detail: "Discord direct-message history proof is still running",
          delayMs: hydrationRetryAfterMs ?? backfillRetryAfterMs ?? undefined,
          scope: firstRunningMessageProof
            ? {
                kind: firstRunningMessageProof.scope.kind,
                key: firstRunningMessageProof.scope.key,
                proofKind: firstRunningMessageProof.proofKind,
              }
            : undefined,
        }
      : undefined,
    proofs,
    diagnostics: {
      discordHydration: buildDiscordHydrationDiagnostics({
        selectedChannelCount: hydrationChannels.length,
        attemptedChannelCount: attemptedHydrationChannelCount,
        completedChannelCount: completedHydrationChannelCount,
        messageLimitPerChannel: syncMessagesPerChannelLimit,
        breakChannelId: hydrationBreakChannelId,
        error: hydrationErrorMessage,
        retryAfterMs: hydrationRetryAfterMs,
      }),
      discordBackfill: buildDiscordHydrationDiagnostics({
        selectedChannelCount: backfillTargets.length,
        attemptedChannelCount: attemptedBackfillChannelCount,
        completedChannelCount: completedBackfillChannelCount,
        messageLimitPerChannel: DISCORD_INCREMENTAL_PAGE_LIMIT,
        breakChannelId: backfillBreakChannelId,
        error: backfillErrorMessage,
        retryAfterMs: backfillRetryAfterMs,
      }),
    },
  };
}

function hasRunningDiscordMessageProof(proofs: SyncProofInput[]): boolean {
  return proofs.some((proof) => proof.proofKind === "messages" && proof.status === "running");
}

function buildDiscordSyncProofs(input: {
  accountKey: string;
  observedAt: number;
  currentUser: DiscordUser;
  channels: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>;
  sourceCursor: DiscordSyncCursor;
  hydratedChannels: DiscordHydratedChannel[];
  backfilledChannels: DiscordBackfilledChannel[];
  nextChannelCursor: DiscordSyncCursor["channels"];
  syncMessagesPerChannelLimit: number;
  hydrationError: string | null;
  hydrationBreakChannelId: string | null;
  hydrationRetryAfterMs: number | null;
}): SyncProofInput[] {
  const proofs: SyncProofInput[] = [
    {
      scope: {
        kind: "account",
        key: input.currentUser.id,
        displayName: discordDisplayName(input.currentUser),
      },
      proofKind: "discovery",
      status: "complete",
      syncMode: "incremental",
      observedAt: input.observedAt,
      completedAt: input.observedAt,
      stats: {
        discoveredDmCount: input.channels.length,
      },
    },
  ];

  const hydratedByChannelId = new Map(
    input.hydratedChannels.map((hydrated) => [hydrated.channelId, hydrated]),
  );
  const backfilledByChannelId = new Map(
    input.backfilledChannels.map((backfilled) => [backfilled.channelId, backfilled]),
  );

  for (const channel of input.channels) {
    const latestMessageId = input.nextChannelCursor[channel.id]?.latestMessageId ?? null;
    const displayName = buildDiscordConversationDisplayName(channel, input.currentUser);
    const scope = {
      kind: "conversation" as const,
      key: channel.id,
      parent: {
        kind: "account" as const,
        key: input.currentUser.id,
      },
      displayName,
      metadata: {
        type: channel.type,
        dmOnly: true,
      },
    };

    proofs.push({
      scope,
      proofKind: "discovery",
      status: "complete",
      syncMode: "incremental",
      observedAt: input.observedAt,
      completedAt: input.observedAt,
      coverage: {
        latestMessageId,
      },
    });

    const hydrated = hydratedByChannelId.get(channel.id);
    const previousLatestMessageId =
      input.sourceCursor.channels[channel.id]?.latestMessageId?.trim() || null;
    if (input.hydrationBreakChannelId === channel.id && input.hydrationError) {
      proofs.push({
        scope,
        proofKind: "latest_messages",
        status: "failed",
        syncMode: "incremental",
        observedAt: input.observedAt,
        completedAt: null,
        resumeCursor: latestMessageId
          ? {
              latestMessageId,
            }
          : null,
        coverage: {
          latestMessageId,
          previousLatestMessageId,
        },
        stats: {
          hydratedThisRun: false,
        },
        error: {
          message: input.hydrationError,
          retryAfterMs: input.hydrationRetryAfterMs,
        },
      });
      continue;
    }

    if (hydrated || (previousLatestMessageId && previousLatestMessageId === latestMessageId)) {
      const proofPreviousLatestMessageId = hydrated
        ? hydrated.previousLatestMessageId
        : previousLatestMessageId;
      proofs.push({
        scope,
        proofKind: "latest_messages",
        status: "complete",
        syncMode: "incremental",
        observedAt: input.observedAt,
        completedAt: input.observedAt,
        coverage: {
          latestMessageId,
          previousLatestMessageId: proofPreviousLatestMessageId,
        },
        stats: {
          hydratedThisRun: hydrated !== undefined,
          messagesFetched: hydrated?.messages.length ?? 0,
        },
      });
    }

    const backfilled = backfilledByChannelId.get(channel.id);
    if (backfilled) {
      proofs.push(
        buildDiscordBackfillProof({
          scope,
          observedAt: input.observedAt,
          backfilled,
        }),
      );
      continue;
    }

    if (!hydrated || hydrated.previousLatestMessageId) {
      continue;
    }

    const oldestMessageId = getOldestDiscordMessageId(hydrated.messages);
    const newestMessageId = getNewestDiscordMessageId(hydrated.messages);
    const historyComplete = hydrated.messages.length < input.syncMessagesPerChannelLimit;
    proofs.push({
      scope,
      proofKind: "messages",
      status: historyComplete ? "complete" : "running",
      syncMode: "incremental",
      observedAt: input.observedAt,
      completedAt: historyComplete ? input.observedAt : null,
      resumeCursor: historyComplete
        ? null
        : {
            before: oldestMessageId,
          },
      coverage: {
        oldestMessageId,
        newestMessageId,
      },
      stats: {
        messagesFetched: hydrated.messages.length,
        messageLimit: input.syncMessagesPerChannelLimit,
      },
    });
  }

  return proofs;
}

function buildDiscordBackfillProof(input: {
  scope: SyncProofInput["scope"];
  observedAt: number;
  backfilled: DiscordBackfilledChannel;
}): SyncProofInput {
  const pageOldestMessageId = getOldestDiscordMessageId(input.backfilled.messages);
  const pageNewestMessageId = getNewestDiscordMessageId(input.backfilled.messages);
  const previousOldestMessageId = getStringRecordValue(
    input.backfilled.coverage,
    "oldestMessageId",
  );
  const previousNewestMessageId = getStringRecordValue(
    input.backfilled.coverage,
    "newestMessageId",
  );
  const oldestMessageId = minDiscordMessageId(previousOldestMessageId, pageOldestMessageId);
  const newestMessageId = maxDiscordMessageId(previousNewestMessageId, pageNewestMessageId);
  const status = input.backfilled.error
    ? "failed"
    : input.backfilled.historyComplete
      ? "complete"
      : "running";

  return {
    scope: input.scope,
    proofKind: "messages",
    status,
    syncMode: "incremental",
    observedAt: input.observedAt,
    completedAt: status === "complete" ? input.observedAt : null,
    resumeCursor:
      status === "complete"
        ? null
        : {
            before: input.backfilled.nextBefore ?? input.backfilled.previousBefore,
          },
    coverage: {
      oldestMessageId,
      newestMessageId,
    },
    stats: {
      messagesFetched: input.backfilled.messages.length,
      messageLimit: DISCORD_INCREMENTAL_PAGE_LIMIT,
      backfill: true,
    },
    error: input.backfilled.error
      ? {
          message: input.backfilled.error,
          retryAfterMs: input.backfilled.retryAfterMs,
          rateLimited: input.backfilled.rateLimited,
        }
      : null,
  };
}

function getOldestDiscordMessageId(messages: DiscordMessage[]): string | null {
  return messages.reduce<string | null>(
    (oldest, message) =>
      !oldest || compareDiscordMessageIds(message.id, oldest) < 0 ? message.id : oldest,
    null,
  );
}

function getNewestDiscordMessageId(messages: DiscordMessage[]): string | null {
  return messages.reduce<string | null>(
    (newest, message) =>
      !newest || compareDiscordMessageIds(message.id, newest) > 0 ? message.id : newest,
    null,
  );
}

function minDiscordMessageId(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareDiscordMessageIds(left, right) <= 0 ? left : right;
}

function maxDiscordMessageId(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareDiscordMessageIds(left, right) >= 0 ? left : right;
}

function compareDiscordMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) {
      return 0;
    }
    return leftId > rightId ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function buildDiscordHydrationDiagnostics(input: {
  selectedChannelCount: number;
  attemptedChannelCount: number;
  completedChannelCount: number;
  messageLimitPerChannel: number;
  breakChannelId: string | null;
  error: string | null;
  retryAfterMs: number | null;
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
    retryAfterMs: input.retryAfterMs,
  };
}

export function getDiscordSyncMessageChannelLimit(): number {
  return parseNonNegativeInteger(
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

export function getDiscordSyncBackfillPageLimit(): number {
  return parseNonNegativeInteger(
    process.env.CUED_DISCORD_SYNC_BACKFILL_PAGE_LIMIT,
    DEFAULT_SYNC_BACKFILL_PAGE_LIMIT,
  );
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  proofState: DiscordProofState,
  limit: number,
): DiscordHydrationTarget[] {
  const dmChannels = channels.filter(
    (channel) => isDiscordDmChannel(channel) && typeof channel.last_message_id === "string",
  );
  const sorted = dmChannels.sort((left, right) =>
    compareDiscordSnowflakesDesc(left.last_message_id!, right.last_message_id!),
  );
  const selected = new Map<string, DiscordHydrationTarget>();
  const changedChannels = sorted.flatMap((channel): DiscordHydrationTarget[] => {
    const latestMessageId = sourceCursor.channels[channel.id]?.latestMessageId ?? null;
    if (!latestMessageId || !isSnowflakeGreater(channel.last_message_id!, latestMessageId)) {
      return [];
    }
    return [
      {
        channel,
        previousLatestMessageId: latestMessageId,
      },
    ];
  });

  for (const target of changedChannels) {
    selected.set(target.channel.id, target);
  }

  const initialChannels = sorted
    .filter(
      (channel) =>
        !selected.has(channel.id) &&
        needsInitialDiscordHydration(channel, sourceCursor, proofState),
    )
    .slice(0, Math.max(0, limit));

  for (const channel of initialChannels) {
    selected.set(channel.id, {
      channel,
      previousLatestMessageId: null,
    });
  }
  return [...selected.values()];
}

function needsInitialDiscordHydration(
  channel: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>[number],
  sourceCursor: DiscordSyncCursor,
  proofState: DiscordProofState,
): boolean {
  const latestMessageId =
    typeof channel.last_message_id === "string" ? channel.last_message_id : null;
  const cursorLatestMessageId = sourceCursor.channels[channel.id]?.latestMessageId ?? null;
  if (!cursorLatestMessageId) {
    return true;
  }

  const latestProof = proofState.latestMessages.get(channel.id);
  if (!latestProof || latestProof.status !== "complete") {
    return true;
  }

  return getStringRecordValue(latestProof.coverage, "latestMessageId") !== latestMessageId;
}

function selectBackfillTargets(
  channels: Awaited<ReturnType<DiscordApiClient["listPrivateChannels"]>>,
  proofState: DiscordProofState,
  limit: number,
): DiscordBackfillTarget[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  return [...proofState.messages.values()]
    .filter((proof) => proof.status !== "complete")
    .flatMap((proof): DiscordBackfillTarget[] => {
      const channel = channelById.get(proof.scopeKey);
      const before = getStringRecordValue(proof.resumeCursor, "before");
      if (!channel || !before) {
        return [];
      }
      return [
        {
          channel,
          before,
          coverage: proof.coverage,
          lastObservedAt: proof.lastObservedAt,
        },
      ];
    })
    .sort((left, right) => (left.lastObservedAt ?? 0) - (right.lastObservedAt ?? 0))
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

function isSnowflakeGreater(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function parseDiscordProofState(value: unknown): DiscordProofState {
  const proofs = Array.isArray(value) ? value : [];
  const state: DiscordProofState = {
    latestMessages: new Map(),
    messages: new Map(),
  };

  for (const proof of proofs) {
    if (!isRecord(proof) || typeof proof.scopeKey !== "string") {
      continue;
    }
    const parsed: DiscordProofSnapshot = {
      scopeKey: proof.scopeKey,
      proofKind: typeof proof.proofKind === "string" ? proof.proofKind : "",
      status: typeof proof.status === "string" ? proof.status : "",
      resumeCursor: isRecord(proof.resumeCursor) ? proof.resumeCursor : null,
      coverage: isRecord(proof.coverage) ? proof.coverage : null,
      lastObservedAt: typeof proof.lastObservedAt === "number" ? proof.lastObservedAt : null,
    };
    if (parsed.proofKind === "latest_messages") {
      state.latestMessages.set(parsed.scopeKey, parsed);
    }
    if (parsed.proofKind === "messages") {
      state.messages.set(parsed.scopeKey, parsed);
    }
  }

  return state;
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

function getStringRecordValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    if (before && !isDiscordMessageIdBefore(oldestPageMessageId, before)) {
      break;
    }

    before = oldestPageMessageId;
  }

  return collected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiscordMessageIdBefore(messageId: string, before: string): boolean {
  return compareDiscordMessageIds(messageId, before) < 0;
}
