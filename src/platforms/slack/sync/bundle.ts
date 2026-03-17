import { createHash } from "node:crypto";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ReactionPayload,
  SourceAccountInput,
} from "../../../core/types/provider.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";
import type { SyncBundle } from "../../core/sync.js";
import {
  SlackClient,
  type SlackConversation,
  type SlackCredentials,
  type SlackMessage,
  type SlackTransport,
  type SlackUser,
} from "../api/index.js";

const INCREMENTAL_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_SLACK_CONVERSATIONS_PER_RUN = 5;
const DEFAULT_SLACK_MESSAGES_PAGE_LIMIT = 100;
const DEFAULT_SLACK_CHANNEL_HISTORY_DAYS = 0;
const DEFAULT_SLACK_API_PAGES_PER_RUN = 25;

type SlackScanMode = "full" | "incremental";
type SlackConversationFamily = "direct" | "channels";

const SLACK_FULL_SCAN_FAMILIES: SlackConversationFamily[] = ["direct", "channels"];
const SLACK_CONVERSATION_TYPES: Record<SlackConversationFamily, string> = {
  direct: "im,mpim",
  channels: "public_channel,private_channel",
};

export interface SlackScanCursor {
  mode: SlackScanMode;
  startedAt: number;
  oldestMs: number;
  usersComplete: boolean;
  conversationFamily?: SlackConversationFamily;
  conversationCursor?: string | null;
  conversationIndex?: number;
  activeConversationId?: string;
  historyCursor?: string | null;
  historyComplete?: boolean;
  pendingThreadTs?: string[];
  activeThreadTs?: string | null;
  repliesCursor?: string | null;
}

export interface SlackSourceCursor {
  teamId: string;
  selfUserId: string;
  lastSyncAt?: number;
  scan?: SlackScanCursor;
}

function now(): number {
  return Date.now();
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function dedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function slackSourceKey(teamId: string, userId: string): string {
  return `slack:${teamId}:${userId}`;
}

function slackMessageKey(teamId: string, conversationId: string, messageTs: string): string {
  return `slack:${teamId}:${conversationId}:${messageTs}`;
}

function timestampMs(slackTs: string | undefined): number | null {
  if (!slackTs) return null;
  const parsed = Number(slackTs);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
}

function formatOldestTs(oldestMs: number): string | undefined {
  if (!Number.isFinite(oldestMs) || oldestMs <= 0) {
    return undefined;
  }
  return (oldestMs / 1000).toFixed(6);
}

function getOldestMessageMs(mode: SlackScanMode, lastSyncAt?: number): number {
  if (mode === "incremental" && lastSyncAt && lastSyncAt > 0) {
    return Math.max(0, lastSyncAt - INCREMENTAL_BUFFER_MS);
  }
  return 0;
}

function isDirectConversation(conversation: SlackConversation): boolean {
  return Boolean(conversation.is_im || conversation.is_mpim);
}

function compareConversationPriority(left: SlackConversation, right: SlackConversation): number {
  const leftDirect = isDirectConversation(left) ? 0 : 1;
  const rightDirect = isDirectConversation(right) ? 0 : 1;
  if (leftDirect !== rightDirect) {
    return leftDirect - rightDirect;
  }

  const leftMembers =
    typeof left.num_members === "number" ? left.num_members : Number.MAX_SAFE_INTEGER;
  const rightMembers =
    typeof right.num_members === "number" ? right.num_members : Number.MAX_SAFE_INTEGER;
  if (leftMembers !== rightMembers) {
    return leftMembers - rightMembers;
  }

  return left.id.localeCompare(right.id);
}

function getConversationHistoryOldestMs(
  mode: SlackScanMode,
  oldestMs: number,
  conversation: SlackConversation,
  observedAt: number,
): number {
  if (mode === "incremental") {
    return oldestMs;
  }

  if (isDirectConversation(conversation)) {
    return oldestMs;
  }

  const historyDays = DEFAULT_SLACK_CHANNEL_HISTORY_DAYS;
  if (historyDays <= 0) {
    return oldestMs;
  }

  const boundedWindowMs = historyDays * 24 * 60 * 60 * 1000;
  return Math.max(oldestMs, observedAt - boundedWindowMs);
}

function isSlackConversationFamily(value: unknown): value is SlackConversationFamily {
  return value === "direct" || value === "channels";
}

function inferConversationFamily(
  conversationCursor: string | null | undefined,
): SlackConversationFamily {
  if (typeof conversationCursor === "string" && conversationCursor.startsWith("im_")) {
    return "direct";
  }
  return "channels";
}

function nextConversationFamily(
  family: SlackConversationFamily,
): SlackConversationFamily | undefined {
  const index = SLACK_FULL_SCAN_FAMILIES.indexOf(family);
  return index >= 0 ? SLACK_FULL_SCAN_FAMILIES[index + 1] : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function bestSlackAvatar(profile: SlackUser["profile"]): string | undefined {
  return profile.image_original || profile.image_512 || profile.image_192 || profile.image_72;
}

function toAttachmentMetadata(message: SlackMessage): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  for (const file of message.files ?? []) {
    attachments.push({
      kind: "file",
      id: file.id,
      name: file.name,
      mimetype: file.mimetype ?? null,
      prettyType: file.pretty_type ?? null,
      size: file.size ?? null,
      url: file.url_private_download ?? file.url_private ?? null,
      previewUrl: file.thumb_480 ?? file.thumb_360 ?? null,
      access_kind: file.url_private_download || file.url_private ? "remote_url" : "none",
      access_ref:
        file.url_private_download || file.url_private
          ? { url: file.url_private_download ?? file.url_private }
          : null,
      preview_ref:
        file.thumb_480 || file.thumb_360 ? { url: file.thumb_480 ?? file.thumb_360 } : null,
      availability_status:
        file.url_private_download || file.url_private ? "available" : "metadata_only",
      provider_metadata: {
        id: file.id,
        prettyType: file.pretty_type ?? null,
      },
    });
  }
  for (const attachment of message.attachments ?? []) {
    attachments.push({
      kind: "attachment",
      title: attachment.title ?? null,
      text: attachment.text ?? attachment.fallback ?? null,
      url: attachment.title_link ?? attachment.image_url ?? attachment.thumb_url ?? null,
      access_kind:
        attachment.title_link || attachment.image_url || attachment.thumb_url
          ? "remote_url"
          : "none",
      access_ref:
        attachment.title_link || attachment.image_url || attachment.thumb_url
          ? { url: attachment.title_link ?? attachment.image_url ?? attachment.thumb_url }
          : null,
      preview_ref:
        attachment.image_url || attachment.thumb_url
          ? { url: attachment.image_url ?? attachment.thumb_url }
          : null,
      availability_status:
        attachment.title_link || attachment.image_url || attachment.thumb_url
          ? "available"
          : "metadata_only",
      provider_metadata: {
        footer: attachment.footer ?? null,
        ts: attachment.ts ?? null,
      },
    });
  }
  return attachments;
}

function buildConversationDisplayName(
  conversation: SlackConversation,
  usersById: Map<string, SlackUser>,
): string {
  if (conversation.is_im && conversation.user) {
    const user = usersById.get(conversation.user);
    if (user) {
      return user.real_name || user.profile.real_name || user.profile.display_name || user.name;
    }
    return conversation.user;
  }

  return (
    conversation.name || conversation.topic?.value || conversation.purpose?.value || conversation.id
  );
}

function shouldIncludeMessage(message: SlackMessage): boolean {
  if (message.subtype === "channel_join" || message.subtype === "channel_leave") {
    return false;
  }
  return Boolean(
    message.text ||
      (message.files && message.files.length > 0) ||
      (message.attachments && message.attachments.length > 0),
  );
}

function shouldFetchConversationIncrementally(
  conversation: SlackConversation,
  oldestMs: number,
): boolean {
  const latestMs = timestampMs(conversation.latest?.ts);
  return latestMs == null || latestMs >= oldestMs;
}

function sortSlackMessages(messages: SlackMessage[]): SlackMessage[] {
  return [...messages].sort((left, right) => {
    const leftTs = Number(left.ts);
    const rightTs = Number(right.ts);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs)) {
      return leftTs - rightTs;
    }
    return left.ts.localeCompare(right.ts);
  });
}

function loadSlackAuthFromKeychain(accountKey: string): SlackCredentials {
  const parsed = loadIntegrationSecret("slack", accountKey).secret;
  if (typeof parsed.token !== "string" || typeof parsed.cookie !== "string") {
    throw new Error(`Slack Keychain payload for '${accountKey}' is missing token or cookie`);
  }
  return {
    token: parsed.token,
    cookie: parsed.cookie,
  };
}

function parseSlackSourceCursor(raw: unknown): SlackSourceCursor | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const lastSyncAt = typeof value.lastSyncAt === "number" ? value.lastSyncAt : undefined;
  const teamId = typeof value.teamId === "string" ? value.teamId : "";
  const selfUserId = typeof value.selfUserId === "string" ? value.selfUserId : "";
  const rawScan = value.scan;
  const scan =
    rawScan && typeof rawScan === "object"
      ? (() => {
          const parsed = rawScan as Record<string, unknown>;
          const mode =
            parsed.mode === "incremental" ? "incremental" : parsed.mode === "full" ? "full" : null;
          const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : null;
          const oldestMs = typeof parsed.oldestMs === "number" ? parsed.oldestMs : null;
          if (!mode || startedAt == null || oldestMs == null) {
            return undefined;
          }
          return {
            mode,
            startedAt,
            oldestMs,
            usersComplete: parsed.usersComplete === true,
            conversationFamily: isSlackConversationFamily(parsed.conversationFamily)
              ? parsed.conversationFamily
              : inferConversationFamily(
                  typeof parsed.conversationCursor === "string" ||
                    parsed.conversationCursor === null
                    ? parsed.conversationCursor
                    : undefined,
                ),
            conversationCursor:
              typeof parsed.conversationCursor === "string" || parsed.conversationCursor === null
                ? parsed.conversationCursor
                : undefined,
            conversationIndex:
              typeof parsed.conversationIndex === "number" && parsed.conversationIndex >= 0
                ? Math.trunc(parsed.conversationIndex)
                : undefined,
            activeConversationId:
              typeof parsed.activeConversationId === "string"
                ? parsed.activeConversationId
                : undefined,
            historyCursor:
              typeof parsed.historyCursor === "string" || parsed.historyCursor === null
                ? parsed.historyCursor
                : undefined,
            historyComplete: parsed.historyComplete === true,
            pendingThreadTs: parseStringArray(parsed.pendingThreadTs),
            activeThreadTs:
              typeof parsed.activeThreadTs === "string" || parsed.activeThreadTs === null
                ? parsed.activeThreadTs
                : undefined,
            repliesCursor:
              typeof parsed.repliesCursor === "string" || parsed.repliesCursor === null
                ? parsed.repliesCursor
                : undefined,
          } satisfies SlackScanCursor;
        })()
      : undefined;

  if (!teamId || !selfUserId) {
    if (lastSyncAt == null && !scan) {
      return undefined;
    }
    return {
      teamId,
      selfUserId,
      lastSyncAt,
      scan,
    };
  }

  return {
    teamId,
    selfUserId,
    lastSyncAt,
    scan,
  };
}

async function listAllUsers(client: SlackTransport): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listUsers(cursor);
    users.push(...result.users.filter((user) => !user.deleted));
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return users;
}

async function listConversationMembers(
  client: SlackTransport,
  conversation: SlackConversation,
): Promise<string[]> {
  if (conversation.is_im && conversation.user) {
    return [conversation.user];
  }

  if (!conversation.is_mpim) {
    return [];
  }

  const members: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.getConversationMembers(conversation.id, cursor);
    members.push(...result.members);
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return [...new Set(members)];
}

async function listConversationMessages(
  client: SlackTransport,
  conversationId: string,
  oldestMs: number,
  messagesPageLimit: number,
): Promise<SlackMessage[]> {
  const messageByTs = new Map<string, SlackMessage>();
  const threadParents = new Set<string>();
  const oldest = formatOldestTs(oldestMs);
  let cursor: string | undefined;

  do {
    const result = await client.getHistory(conversationId, {
      cursor,
      oldest,
      limit: messagesPageLimit,
    });

    for (const message of result.messages) {
      if (message.reply_count && message.reply_count > 0) {
        threadParents.add(message.ts);
      }
      if (!shouldIncludeMessage(message)) {
        continue;
      }
      messageByTs.set(message.ts, message);
    }

    cursor = result.nextCursor || undefined;
  } while (cursor);

  for (const threadTs of threadParents) {
    let repliesCursor: string | undefined;
    do {
      const result = await client.getReplies(conversationId, threadTs, {
        cursor: repliesCursor,
        oldest,
        limit: messagesPageLimit,
      });

      for (const reply of result.messages) {
        if (reply.ts === threadTs || !shouldIncludeMessage(reply)) {
          continue;
        }
        messageByTs.set(reply.ts, reply);
      }

      repliesCursor = result.nextCursor || undefined;
    } while (repliesCursor);
  }

  return sortSlackMessages(Array.from(messageByTs.values()));
}

interface SlackConversationResumeState {
  historyCursor: string | null;
  historyComplete: boolean;
  pendingThreadTs: string[];
  activeThreadTs: string | null;
  repliesCursor: string | null;
}

interface SlackConversationBatchResult {
  messages: SlackMessage[];
  complete: boolean;
  resumeState: SlackConversationResumeState;
}

async function listConversationMessagesBatch(
  client: SlackTransport,
  conversationId: string,
  oldestMs: number,
  messagesPageLimit: number,
  resumeState?: Partial<SlackConversationResumeState>,
  apiPageBudget: number = DEFAULT_SLACK_API_PAGES_PER_RUN,
): Promise<SlackConversationBatchResult> {
  const oldest = formatOldestTs(oldestMs);
  const messages: SlackMessage[] = [];
  const seenMessageTs = new Set<string>();
  const pendingThreadTs = [...(resumeState?.pendingThreadTs ?? [])];
  let historyCursor = resumeState?.historyCursor ?? null;
  let historyComplete = resumeState?.historyComplete ?? false;
  let activeThreadTs = resumeState?.activeThreadTs ?? null;
  let repliesCursor = resumeState?.repliesCursor ?? null;
  let apiPagesRemaining = apiPageBudget;

  const addMessage = (message: SlackMessage) => {
    if (!shouldIncludeMessage(message) || seenMessageTs.has(message.ts)) {
      return;
    }
    seenMessageTs.add(message.ts);
    messages.push(message);
  };

  while (apiPagesRemaining > 0) {
    if (activeThreadTs) {
      const result = await client.getReplies(conversationId, activeThreadTs, {
        cursor: repliesCursor ?? undefined,
        oldest,
        limit: messagesPageLimit,
      });
      apiPagesRemaining -= 1;
      for (const reply of result.messages) {
        if (reply.ts === activeThreadTs) {
          continue;
        }
        addMessage(reply);
      }
      repliesCursor = result.nextCursor ?? null;
      if (!repliesCursor) {
        activeThreadTs = pendingThreadTs.shift() ?? null;
      }
      continue;
    }

    if (!historyComplete) {
      const result = await client.getHistory(conversationId, {
        cursor: historyCursor ?? undefined,
        oldest,
        limit: messagesPageLimit,
      });
      apiPagesRemaining -= 1;
      for (const message of result.messages) {
        if (message.reply_count && message.reply_count > 0) {
          pendingThreadTs.push(message.ts);
        }
        addMessage(message);
      }
      historyCursor = result.nextCursor ?? null;
      if (!historyCursor) {
        historyComplete = true;
      }
      if (!activeThreadTs && pendingThreadTs.length > 0) {
        activeThreadTs = pendingThreadTs.shift() ?? null;
      }
      continue;
    }

    break;
  }

  return {
    messages: sortSlackMessages(messages),
    complete: historyComplete && !activeThreadTs && pendingThreadTs.length === 0,
    resumeState: {
      historyCursor,
      historyComplete,
      pendingThreadTs,
      activeThreadTs,
      repliesCursor: activeThreadTs ? repliesCursor : null,
    },
  };
}

function buildContactEvents(
  teamId: string,
  accountKey: string,
  observedAt: number,
  users: SlackUser[],
): SyncBundle["rawEvents"] {
  return users.map((user) => {
    const contactId = dedupeKey(`slack:contact:${teamId}:${user.id}`);
    return {
      id: contactId,
      platform: "slack",
      accountKey,
      entityKind: "contact",
      eventKind: "observed",
      externalEntityId: user.id,
      observedAt,
      dedupeKey: contactId,
      payload: {
        sourceEntityKey: slackSourceKey(teamId, user.id),
        fields: {
          display_name:
            user.real_name || user.profile.real_name || user.profile.display_name || user.name,
          photo_url: bestSlackAvatar(user.profile) ?? null,
        },
        handles: [
          {
            type: "slack_user_id",
            value: `${teamId}:${user.id}`,
            deterministic: true,
          },
          ...(user.profile.email
            ? [
                {
                  type: "email",
                  value: user.profile.email,
                  deterministic: true,
                },
              ]
            : []),
        ],
      } satisfies ContactObservationPayload,
      sourceVersion: "slack-v1",
    };
  });
}

function buildMessageEvents(
  teamId: string,
  accountKey: string,
  conversationId: string,
  selfUserId: string,
  observedAt: number,
  messages: SlackMessage[],
): SyncBundle["rawEvents"] {
  const rawEvents: SyncBundle["rawEvents"] = [];

  for (const message of messages) {
    const messageTsMs = timestampMs(message.ts) ?? observedAt;
    const attachments = toAttachmentMetadata(message);
    const senderUserId = message.user ?? message.bot_id;
    const messageId = dedupeKey(
      `slack:message:${teamId}:${conversationId}:${message.ts}:${message.text ?? ""}:${message.edited?.ts ?? ""}`,
    );

    rawEvents.push({
      id: messageId,
      platform: "slack",
      accountKey,
      entityKind: "message",
      eventKind: "message_created",
      externalEntityId: `${conversationId}:${message.ts}`,
      conversationExternalId: conversationId,
      occurredAt: messageTsMs,
      observedAt,
      dedupeKey: messageId,
      payload: {
        sourceMessageKey: slackMessageKey(teamId, conversationId, message.ts),
        sourceConversationKey: `slack:${teamId}:${conversationId}`,
        senderSourceKey:
          senderUserId && senderUserId !== selfUserId ? slackSourceKey(teamId, senderUserId) : null,
        sentAt: messageTsMs,
        content:
          message.text ||
          attachments
            .map((attachment) =>
              String(attachment.title ?? attachment.name ?? attachment.text ?? ""),
            )
            .filter(Boolean)
            .join("\n"),
        service: "slack",
        status: null,
        isFromMe: senderUserId === selfUserId,
        editedAt: timestampMs(message.edited?.ts),
        isEdited: Boolean(message.edited?.ts),
        isDeleted: false,
        replyToSourceMessageKey:
          message.thread_ts && message.thread_ts !== message.ts
            ? slackMessageKey(teamId, conversationId, message.thread_ts)
            : null,
        attachments,
      } satisfies MessagePayload,
      sourceVersion: "slack-v1",
    });

    for (const reaction of message.reactions ?? []) {
      for (const reactorUserId of reaction.users) {
        const reactionId = dedupeKey(
          `slack:reaction:${teamId}:${conversationId}:${message.ts}:${reaction.name}:${reactorUserId}`,
        );
        rawEvents.push({
          id: reactionId,
          platform: "slack",
          accountKey,
          entityKind: "reaction",
          eventKind: "reaction_added",
          externalEntityId: `${conversationId}:${message.ts}:${reaction.name}:${reactorUserId}`,
          conversationExternalId: conversationId,
          occurredAt: messageTsMs,
          observedAt,
          dedupeKey: reactionId,
          payload: {
            sourceMessageKey: slackMessageKey(teamId, conversationId, message.ts),
            sourceConversationKey: `slack:${teamId}:${conversationId}`,
            reactorSourceKey:
              reactorUserId === selfUserId ? null : slackSourceKey(teamId, reactorUserId),
            emoji: `:${reaction.name}:`,
            timestamp: messageTsMs,
            isActive: true,
          } satisfies ReactionPayload,
          sourceVersion: "slack-v1",
        });
      }
    }
  }

  return rawEvents;
}

export async function buildSlackSyncBundle(options?: {
  accountKey?: string;
  lastSyncAt?: number;
  sourceCursor?: unknown;
  client?: SlackTransport;
  conversationPageLimit?: number;
  messagesPageLimit?: number;
  apiPageBudget?: number;
}): Promise<SyncBundle> {
  const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const loadedAuth = options?.client ? null : loadSlackAuthFromKeychain(accountKey);
  const client = options?.client ?? new SlackClient(loadedAuth!);
  const savedCursor = parseSlackSourceCursor(options?.sourceCursor);
  const previousLastSyncAt =
    typeof options?.lastSyncAt === "number" ? options.lastSyncAt : savedCursor?.lastSyncAt;

  const auth = await client.testAuth();
  if (!auth.ok || !auth.team_id || !auth.user_id) {
    throw new Error(`Slack auth test failed for '${accountKey}': ${auth.error ?? "unknown_error"}`);
  }

  const teamId = auth.team_id;
  const teamName = auth.team ?? teamId;
  const selfUserId = auth.user_id;
  const observedBase = now();
  const conversationPageLimit = positiveInt(
    options?.conversationPageLimit ?? DEFAULT_SLACK_CONVERSATIONS_PER_RUN,
    25,
  );
  const messagesPageLimit = positiveInt(
    options?.messagesPageLimit ?? DEFAULT_SLACK_MESSAGES_PAGE_LIMIT,
    100,
  );
  const apiPageBudget = positiveInt(options?.apiPageBudget ?? DEFAULT_SLACK_API_PAGES_PER_RUN, 25);

  const mode: SlackScanMode = previousLastSyncAt && previousLastSyncAt > 0 ? "incremental" : "full";
  const scan: SlackScanCursor = savedCursor?.scan ?? {
    mode,
    startedAt: observedBase,
    oldestMs: getOldestMessageMs(mode, previousLastSyncAt),
    usersComplete: Boolean(previousLastSyncAt && previousLastSyncAt > 0),
    conversationFamily: "direct",
    conversationCursor: null,
  };

  const sourceAccounts: SourceAccountInput[] = [
    {
      platform: "slack",
      accountKey,
      displayName: teamName,
    },
  ];
  const rawEvents: SyncBundle["rawEvents"] = [];
  const usersById = new Map<string, SlackUser>();

  if (scan.mode === "full" && !scan.usersComplete) {
    const users = await listAllUsers(client);
    rawEvents.push(...buildContactEvents(teamId, accountKey, observedBase, users));
    for (const user of users) {
      usersById.set(user.id, user);
    }
    scan.usersComplete = true;
  }

  const conversationPages =
    scan.mode === "incremental"
      ? await Promise.all(
          SLACK_FULL_SCAN_FAMILIES.map(async (family) => ({
            family,
            page: await client.listConversations(
              SLACK_CONVERSATION_TYPES[family],
              undefined,
              conversationPageLimit,
            ),
          })),
        )
      : [
          {
            family: scan.conversationFamily ?? "direct",
            page: await client.listConversations(
              SLACK_CONVERSATION_TYPES[scan.conversationFamily ?? "direct"],
              scan.conversationCursor ?? undefined,
              conversationPageLimit,
            ),
          },
        ];

  for (const { page, family } of conversationPages) {
    const orderedConversations = [...page.conversations].sort(compareConversationPriority);
    if (scan.mode === "full") {
      if (orderedConversations.length === 0) {
        continue;
      }

      let conversationIndex = Math.max(0, scan.conversationIndex ?? 0);
      if (scan.activeConversationId) {
        const activeIndex = orderedConversations.findIndex(
          (conversation) => conversation.id === scan.activeConversationId,
        );
        if (activeIndex >= 0) {
          conversationIndex = activeIndex;
        }
      }

      if (conversationIndex >= orderedConversations.length) {
        conversationIndex = orderedConversations.length - 1;
      }

      const conversation = orderedConversations[conversationIndex];
      const conversationOldestMs = getConversationHistoryOldestMs(
        scan.mode,
        scan.oldestMs,
        conversation,
        observedBase,
      );
      const memberIds = await listConversationMembers(client, conversation);
      const messageBatch = await listConversationMessagesBatch(
        client,
        conversation.id,
        conversationOldestMs,
        messagesPageLimit,
        scan.activeConversationId === conversation.id
          ? {
              historyCursor: scan.historyCursor ?? null,
              historyComplete: scan.historyComplete === true,
              pendingThreadTs: scan.pendingThreadTs ?? [],
              activeThreadTs: scan.activeThreadTs ?? null,
              repliesCursor: scan.repliesCursor ?? null,
            }
          : undefined,
        apiPageBudget,
      );

      const conversationId = dedupeKey(`slack:conversation:${teamId}:${conversation.id}`);
      rawEvents.push({
        id: conversationId,
        platform: "slack",
        accountKey,
        entityKind: "conversation",
        eventKind: "observed",
        conversationExternalId: conversation.id,
        observedAt: observedBase,
        dedupeKey: conversationId,
        payload: {
          sourceConversationKey: `slack:${teamId}:${conversation.id}`,
          conversationType:
            conversation.is_mpim || conversation.is_channel || conversation.is_group
              ? "group"
              : "dm",
          displayName: buildConversationDisplayName(conversation, usersById),
          nativeConversationKey: conversation.id,
          service: "slack",
          participants: memberIds.map((memberId) => ({
            sourceEntityKey: slackSourceKey(teamId, memberId),
            isSelf: memberId === selfUserId,
          })),
        } satisfies ConversationObservationPayload,
        sourceVersion: "slack-v1",
      });

      rawEvents.push(
        ...buildMessageEvents(
          teamId,
          accountKey,
          conversation.id,
          selfUserId,
          observedBase,
          messageBatch.messages,
        ),
      );

      let sourceCursor: SlackSourceCursor;
      let hasMore = false;
      const nextCursor = page.conversations.length > 0 ? page.nextCursor || null : null;
      const nextFamily = nextConversationFamily(family);

      if (!messageBatch.complete) {
        hasMore = true;
        sourceCursor = {
          teamId,
          selfUserId,
          lastSyncAt: previousLastSyncAt,
          scan: {
            ...scan,
            usersComplete: scan.usersComplete,
            conversationFamily: family,
            conversationCursor: scan.conversationCursor ?? null,
            conversationIndex,
            activeConversationId: conversation.id,
            historyCursor: messageBatch.resumeState.historyCursor,
            historyComplete: messageBatch.resumeState.historyComplete,
            pendingThreadTs: messageBatch.resumeState.pendingThreadTs,
            activeThreadTs: messageBatch.resumeState.activeThreadTs,
            repliesCursor: messageBatch.resumeState.repliesCursor,
          },
        };
      } else if (conversationIndex + 1 < orderedConversations.length) {
        hasMore = true;
        sourceCursor = {
          teamId,
          selfUserId,
          lastSyncAt: previousLastSyncAt,
          scan: {
            ...scan,
            usersComplete: scan.usersComplete,
            conversationFamily: family,
            conversationCursor: scan.conversationCursor ?? null,
            conversationIndex: conversationIndex + 1,
            activeConversationId: undefined,
            historyCursor: undefined,
            historyComplete: undefined,
            pendingThreadTs: undefined,
            activeThreadTs: undefined,
            repliesCursor: undefined,
          },
        };
      } else {
        const nextScanFamily = nextCursor != null ? family : nextFamily;
        if (nextScanFamily) {
          hasMore = true;
          sourceCursor = {
            teamId,
            selfUserId,
            lastSyncAt: previousLastSyncAt,
            scan: {
              ...scan,
              usersComplete: scan.usersComplete,
              conversationFamily: nextScanFamily,
              conversationCursor: nextCursor != null ? nextCursor : null,
              conversationIndex: undefined,
              activeConversationId: undefined,
              historyCursor: undefined,
              historyComplete: undefined,
              pendingThreadTs: undefined,
              activeThreadTs: undefined,
              repliesCursor: undefined,
            },
          };
        } else {
          sourceCursor = {
            teamId,
            selfUserId,
            lastSyncAt: scan.startedAt,
          };
        }
      }

      return {
        sourceAccounts,
        rawEvents,
        sourceCursor,
        syncMode: scan.mode,
        hasMore,
      };
    }

    for (const conversation of orderedConversations) {
      if (
        scan.mode === "incremental" &&
        !shouldFetchConversationIncrementally(conversation, scan.oldestMs)
      ) {
        continue;
      }

      const conversationOldestMs = getConversationHistoryOldestMs(
        scan.mode,
        scan.oldestMs,
        conversation,
        observedBase,
      );
      const memberIds = await listConversationMembers(client, conversation);
      const messages = await listConversationMessages(
        client,
        conversation.id,
        conversationOldestMs,
        messagesPageLimit,
      );

      const conversationId = dedupeKey(`slack:conversation:${teamId}:${conversation.id}`);
      rawEvents.push({
        id: conversationId,
        platform: "slack",
        accountKey,
        entityKind: "conversation",
        eventKind: "observed",
        conversationExternalId: conversation.id,
        observedAt: observedBase,
        dedupeKey: conversationId,
        payload: {
          sourceConversationKey: `slack:${teamId}:${conversation.id}`,
          conversationType:
            conversation.is_mpim || conversation.is_channel || conversation.is_group
              ? "group"
              : "dm",
          displayName: buildConversationDisplayName(conversation, usersById),
          nativeConversationKey: conversation.id,
          service: "slack",
          participants: memberIds.map((memberId) => ({
            sourceEntityKey: slackSourceKey(teamId, memberId),
            isSelf: memberId === selfUserId,
          })),
        } satisfies ConversationObservationPayload,
        sourceVersion: "slack-v1",
      });

      rawEvents.push(
        ...buildMessageEvents(
          teamId,
          accountKey,
          conversation.id,
          selfUserId,
          observedBase,
          messages,
        ),
      );
    }
  }

  let sourceCursor: SlackSourceCursor;
  let hasMore = false;

  if (scan.mode === "full") {
    const currentFamily = scan.conversationFamily ?? "direct";
    const currentPage = conversationPages[0].page;
    // Slack can return an empty page with a dangling cursor once it has exhausted
    // the current conversation family that the token can actually access.
    const nextCursor = currentPage.conversations.length > 0 ? currentPage.nextCursor || null : null;
    const nextFamily = nextConversationFamily(currentFamily);
    const nextScanFamily = nextCursor != null ? currentFamily : nextFamily;

    if (nextScanFamily) {
      hasMore = true;
      sourceCursor = {
        teamId,
        selfUserId,
        lastSyncAt: previousLastSyncAt,
        scan: {
          ...scan,
          usersComplete: scan.usersComplete,
          conversationFamily: nextScanFamily,
          conversationCursor: nextCursor != null ? nextCursor : null,
        },
      };
    } else {
      sourceCursor = {
        teamId,
        selfUserId,
        lastSyncAt: scan.startedAt,
      };
    }
  } else {
    sourceCursor = {
      teamId,
      selfUserId,
      lastSyncAt: scan.startedAt,
    };
  }

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor,
    syncMode: scan.mode,
    hasMore,
  };
}
