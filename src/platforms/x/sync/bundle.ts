import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ProviderRawEventInput,
} from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import { resolveBirdclawDatabasePath, resolveBirdclawHelperBinary } from "../helper/binary.js";

const execFileAsync = promisify(execFile);

export interface BirdclawSnapshot {
  account: { id: string; name: string; handle: string; external_user_id: string };
  profiles: Array<{
    id: string;
    handle: string;
    display_name: string;
    bio: string;
    followers_count: number;
    following_count: number;
    avatar_url: string;
    location: string;
    url: string;
    verified_type: string;
  }>;
  conversations: Array<{
    id: string;
    participant_profile_id: string;
    title: string;
    last_message_at: string;
  }>;
  messages: Array<{
    id: string;
    conversation_id: string;
    sender_profile_id: string;
    text: string;
    created_at: string;
    direction: string;
  }>;
  followEdges: Array<{
    direction: string;
    profile_id: string;
    external_user_id: string;
    source: string;
    first_seen_at: string;
    last_seen_at: string;
  }>;
  hasMore: boolean;
  nextCreatedAt?: string;
  nextMessageId?: string;
}

type BirdclawCursor = { createdAt: string | null; messageId: string | null };

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function parseCursor(value: unknown): BirdclawCursor {
  const cursor = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    createdAt: typeof cursor.createdAt === "string" ? cursor.createdAt : null,
    messageId: typeof cursor.messageId === "string" ? cursor.messageId : null,
  };
}

async function readBirdclawSnapshot(
  accountKey: string,
  cursor: BirdclawCursor,
): Promise<BirdclawSnapshot> {
  const helper = resolveBirdclawHelperBinary();
  if (!helper) throw new Error("Birdclaw helper is not installed");
  const args = ["sync", "--db", resolveBirdclawDatabasePath(), "--account", accountKey];
  if (cursor.createdAt) {
    args.push("--after-created-at", cursor.createdAt, "--after-message-id", cursor.messageId ?? "");
  }
  const { stdout } = await execFileAsync(helper, args, {
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout) as BirdclawSnapshot;
}

function sourceKey(id: string): string {
  return `x:user:${id}`;
}

export function buildBirdclawRawEvents(input: {
  accountKey: string;
  snapshot: BirdclawSnapshot;
  observedAt: number;
}): SyncBundle["rawEvents"] {
  const { snapshot } = input;
  const relationshipByProfile = new Map<string, Set<string>>();
  const externalIdByProfile = new Map<string, string>();
  for (const edge of snapshot.followEdges) {
    const directions = relationshipByProfile.get(edge.profile_id) ?? new Set<string>();
    directions.add(edge.direction);
    relationshipByProfile.set(edge.profile_id, directions);
    if (edge.external_user_id) externalIdByProfile.set(edge.profile_id, edge.external_user_id);
  }
  const profileSourceKeys = new Map<string, string>();
  const rawEvents: SyncBundle["rawEvents"] = [];
  for (const profile of snapshot.profiles) {
    const externalId = externalIdByProfile.get(profile.id) || profile.id;
    const contactSourceKey = sourceKey(externalId);
    profileSourceKeys.set(profile.id, contactSourceKey);
    const directions = relationshipByProfile.get(profile.id) ?? new Set<string>();
    const id = stableId(`x:contact:${input.accountKey}:${externalId}`);
    rawEvents.push({
      id,
      platform: "x",
      accountKey: input.accountKey,
      entityKind: "contact",
      eventKind: "observed",
      externalEntityId: externalId,
      observedAt: input.observedAt,
      dedupeKey: id,
      payload: {
        sourceEntityKey: contactSourceKey,
        fields: {
          display_name:
            profile.display_name || (profile.handle ? `@${profile.handle}` : profile.id),
          photo_url: profile.avatar_url || null,
        },
        handles: [
          ...(externalId !== profile.id
            ? [{ type: "x_user_id", value: externalId, deterministic: true }]
            : []),
          ...(profile.handle
            ? [
                { type: "x_handle", value: profile.handle, deterministic: true },
                {
                  type: "x_profile_url",
                  value: `https://x.com/${profile.handle}`,
                  deterministic: true,
                },
              ]
            : []),
        ],
        sourceProfileUrl: profile.handle ? `https://x.com/${profile.handle}` : null,
        sourceMetadata: {
          birdclawProfileId: profile.id,
          bio: profile.bio,
          location: profile.location,
          url: profile.url,
          verifiedType: profile.verified_type,
          followersCount: profile.followers_count,
          followingCount: profile.following_count,
          followsYou: directions.has("followers"),
          youFollow: directions.has("following"),
          mutual: directions.has("followers") && directions.has("following"),
        },
      } satisfies ContactObservationPayload,
    } satisfies ProviderRawEventInput<ContactObservationPayload>);
  }

  const selfKey = sourceKey(snapshot.account.external_user_id || snapshot.account.id);
  for (const conversation of snapshot.conversations) {
    const conversationId = stableId(`x:conversation:${input.accountKey}:${conversation.id}`);
    const remoteKey = profileSourceKeys.get(conversation.participant_profile_id);
    rawEvents.push({
      id: conversationId,
      platform: "x",
      accountKey: input.accountKey,
      entityKind: "conversation",
      eventKind: "observed",
      conversationExternalId: conversation.id,
      observedAt: input.observedAt,
      dedupeKey: conversationId,
      payload: {
        sourceConversationKey: `x:conversation:${conversation.id}`,
        conversationType: "dm",
        displayName: conversation.title || "X conversation",
        participants: [
          { sourceEntityKey: selfKey, isSelf: true },
          ...(remoteKey ? [{ sourceEntityKey: remoteKey }] : []),
        ],
      } satisfies ConversationObservationPayload,
    });
  }
  for (const message of snapshot.messages) {
    const sentAt = Date.parse(message.created_at);
    const id = stableId(`x:message:${input.accountKey}:${message.id}`);
    rawEvents.push({
      id,
      platform: "x",
      accountKey: input.accountKey,
      entityKind: "message",
      eventKind: "created",
      externalEntityId: message.id,
      conversationExternalId: message.conversation_id,
      occurredAt: Number.isFinite(sentAt) ? sentAt : input.observedAt,
      observedAt: input.observedAt,
      dedupeKey: id,
      payload: {
        sourceMessageKey: `x:message:${message.id}`,
        sourceConversationKey: `x:conversation:${message.conversation_id}`,
        senderSourceKey:
          message.direction === "outbound"
            ? selfKey
            : (profileSourceKeys.get(message.sender_profile_id) ?? null),
        sentAt: Number.isFinite(sentAt) ? sentAt : input.observedAt,
        content: message.text,
        isFromMe: message.direction === "outbound",
      } satisfies MessagePayload,
    });
  }
  return rawEvents;
}

export async function buildXSyncBundle(
  input: { accountKey?: string } = {},
  options: { snapshot?: BirdclawSnapshot; sourceCursor?: unknown } = {},
): Promise<SyncBundle> {
  const requestedAccountKey = input.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
  const cursor = parseCursor(options.sourceCursor);
  const snapshot = options.snapshot ?? (await readBirdclawSnapshot(requestedAccountKey, cursor));
  const accountKey = snapshot.account.id;
  const observedAt = Date.now();
  const rawEvents = buildBirdclawRawEvents({ accountKey, snapshot, observedAt });
  const sourceCursor: BirdclawCursor = {
    createdAt: snapshot.nextCreatedAt ?? cursor.createdAt,
    messageId: snapshot.nextMessageId ?? cursor.messageId,
  };
  return {
    sourceAccounts: [
      {
        platform: "x",
        accountKey,
        displayName: snapshot.account.handle
          ? `@${snapshot.account.handle}`
          : snapshot.account.name,
      },
    ],
    rawEvents,
    sourceCursor,
    syncMode: cursor.createdAt ? "incremental" : "full",
    hasMore: snapshot.hasMore,
    continuation: snapshot.hasMore
      ? { reason: "account_pagination", detail: "Birdclaw DM page remains" }
      : undefined,
    proofs: [
      {
        scope: { kind: "account", key: "birdclaw_local_archive" },
        proofKind: "messages",
        status: snapshot.hasMore ? "running" : "complete",
        observedAt,
        resumeCursor: snapshot.hasMore ? sourceCursor : null,
        coverage: {
          source: "birdclaw.sqlite",
          relationshipEdges: snapshot.followEdges.length,
        },
        stats: { messageCount: snapshot.messages.length, rawEventCount: rawEvents.length },
      },
    ],
  };
}
