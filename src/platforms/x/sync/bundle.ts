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
import { resolveBirdclawHelperBinary, resolveXArchivePath } from "../helper/binary.js";

const execFileAsync = promisify(execFile);

export interface BirdclawSnapshot {
  generation: string;
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
    participant_ids: string[];
    title: string;
    last_message_at: string;
    is_group: boolean;
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
  nextPhase?: string;
  nextEdgeOffset?: number;
  nextCreatedAt?: string;
  nextMessageId?: string;
}

type BirdclawCursor = {
  generation: string | null;
  phase: "messages" | "relationships";
  createdAt: string | null;
  messageId: string | null;
  edgeOffset: number;
};

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function parseCursor(value: unknown): BirdclawCursor {
  const cursor = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    generation: typeof cursor.generation === "string" ? cursor.generation : null,
    phase: cursor.phase === "relationships" ? "relationships" : "messages",
    createdAt: typeof cursor.createdAt === "string" ? cursor.createdAt : null,
    messageId: typeof cursor.messageId === "string" ? cursor.messageId : null,
    edgeOffset: typeof cursor.edgeOffset === "number" ? cursor.edgeOffset : 0,
  };
}

async function readBirdclawSnapshot(cursor: BirdclawCursor): Promise<BirdclawSnapshot> {
  const helper = resolveBirdclawHelperBinary();
  const archivePath = resolveXArchivePath();
  if (!helper) throw new Error("X archive helper is not installed");
  if (!archivePath) throw new Error("X archive was not found; set CUED_X_ARCHIVE_PATH");
  const args = [
    "sync",
    "--archive",
    archivePath,
    "--phase",
    cursor.phase,
    "--edge-offset",
    String(cursor.edgeOffset),
  ];
  if (cursor.generation) args.push("--generation", cursor.generation);
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

function externalUserId(profileId: string): string | null {
  return profileId.startsWith("profile_user_") ? profileId.slice("profile_user_".length) : null;
}

export function buildBirdclawRawEvents(input: {
  accountKey: string;
  snapshot: BirdclawSnapshot;
  observedAt: number;
}): SyncBundle["rawEvents"] {
  const { snapshot } = input;
  const relationshipByProfile = new Map<string, Set<string>>();
  for (const edge of snapshot.followEdges ?? []) {
    const directions = relationshipByProfile.get(edge.profile_id) ?? new Set<string>();
    directions.add(edge.direction);
    relationshipByProfile.set(edge.profile_id, directions);
  }
  const rawEvents: SyncBundle["rawEvents"] = [];
  for (const profile of snapshot.profiles ?? []) {
    const externalId = externalUserId(profile.id);
    if (!externalId) continue;
    const contactSourceKey = sourceKey(externalId);
    const directions = relationshipByProfile.get(profile.id) ?? new Set<string>();
    const sourceMetadata = {
      archiveGeneration: snapshot.generation,
      bio: profile.bio,
      location: profile.location,
      url: profile.url,
      verifiedType: profile.verified_type,
      followersCount: profile.followers_count,
      followingCount: profile.following_count,
      followsYou: directions.has("followers"),
      youFollow: directions.has("following"),
      mutual: directions.has("followers") && directions.has("following"),
    };
    const eventVersion = stableId(
      JSON.stringify({
        displayName: profile.display_name,
        handle: profile.handle,
        avatarUrl: profile.avatar_url,
        sourceMetadata,
      }),
    );
    const id = stableId(`x:contact:${input.accountKey}:${externalId}:${eventVersion}`);
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
          ...sourceMetadata,
        },
      } satisfies ContactObservationPayload,
    } satisfies ProviderRawEventInput<ContactObservationPayload>);
  }

  const selfKey = sourceKey(snapshot.account.external_user_id || snapshot.account.id);
  for (const conversation of snapshot.conversations ?? []) {
    const conversationId = stableId(`x:conversation:${input.accountKey}:${conversation.id}`);
    const remoteKeys = conversation.participant_ids.map(sourceKey);
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
        conversationType: conversation.is_group ? "group" : "dm",
        displayName: conversation.title || "X conversation",
        participants: [
          { sourceEntityKey: selfKey, isSelf: true },
          ...remoteKeys.map((participantKey) => ({ sourceEntityKey: participantKey })),
        ],
      } satisfies ConversationObservationPayload,
    });
  }
  for (const message of snapshot.messages ?? []) {
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
            : externalUserId(message.sender_profile_id)
              ? sourceKey(externalUserId(message.sender_profile_id)!)
              : null,
        sentAt: Number.isFinite(sentAt) ? sentAt : input.observedAt,
        content: message.text,
        isFromMe: message.direction === "outbound",
      } satisfies MessagePayload,
    });
  }
  return rawEvents;
}

export async function buildXSyncBundle(
  _input: { accountKey?: string } = {},
  options: { snapshot?: BirdclawSnapshot; sourceCursor?: unknown } = {},
): Promise<SyncBundle> {
  const cursor = parseCursor(options.sourceCursor);
  const snapshot = options.snapshot ?? (await readBirdclawSnapshot(cursor));
  const accountKey = snapshot.account.id;
  const observedAt = Date.now();
  const rawEvents = buildBirdclawRawEvents({ accountKey, snapshot, observedAt });
  const sourceCursor: BirdclawCursor = snapshot.hasMore
    ? {
        generation: snapshot.generation,
        phase: snapshot.nextPhase === "relationships" ? "relationships" : "messages",
        createdAt: snapshot.nextCreatedAt ?? cursor.createdAt,
        messageId: snapshot.nextMessageId ?? cursor.messageId,
        edgeOffset: snapshot.nextEdgeOffset ?? 0,
      }
    : {
        generation: snapshot.generation,
        phase: "messages",
        createdAt: null,
        messageId: null,
        edgeOffset: 0,
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
    syncMode: "full",
    hasMore: snapshot.hasMore,
    continuation: snapshot.hasMore
      ? { reason: "account_pagination", detail: "X archive page remains" }
      : undefined,
    proofs: [
      {
        scope: { kind: "account", key: "x_archive" },
        proofKind: "messages",
        status: snapshot.hasMore ? "running" : "complete",
        observedAt,
        resumeCursor: snapshot.hasMore ? sourceCursor : null,
        coverage: {
          source: "x_archive",
          generation: snapshot.generation,
          relationshipEdges: snapshot.followEdges?.length ?? 0,
        },
        stats: { messageCount: snapshot.messages?.length ?? 0, rawEventCount: rawEvents.length },
      },
    ],
  };
}
