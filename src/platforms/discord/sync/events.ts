import { createHash } from "node:crypto";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
} from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import type { DiscordChannel, DiscordMessage, DiscordUser } from "../types.js";
import {
  discordAvatarUrl,
  discordConversationSourceKey,
  discordDisplayName,
  discordMessageSourceKey,
  discordSourceKey,
} from "../types.js";

export function discordDedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function discordTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildDiscordContactEvent(input: {
  accountKey: string;
  observedAt: number;
  user: DiscordUser;
  displayName?: string | null;
}): SyncBundle["rawEvents"][number] {
  const displayName = input.displayName?.trim() || discordDisplayName(input.user);
  const id = discordDedupeKey(`discord:contact:${input.accountKey}:${input.user.id}`);
  return {
    id,
    platform: "discord",
    accountKey: input.accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: input.user.id,
    observedAt: input.observedAt,
    dedupeKey: id,
    payload: {
      sourceEntityKey: discordSourceKey(input.user.id),
      fields: {
        display_name: displayName,
        photo_url: discordAvatarUrl(input.user),
      },
      handles: [
        {
          type: "discord_user_id",
          value: input.user.id,
          deterministic: true,
        },
      ],
    } satisfies ContactObservationPayload,
    sourceVersion: "discord-v1",
  };
}

export function buildDiscordConversationEvent(input: {
  accountKey: string;
  observedAt: number;
  channel: DiscordChannel;
  currentUser: DiscordUser;
}): SyncBundle["rawEvents"][number] {
  const id = discordDedupeKey(`discord:conversation:${input.accountKey}:${input.channel.id}`);
  const displayName = buildDiscordConversationDisplayName(input.channel, input.currentUser);
  const participants = [
    {
      sourceEntityKey: discordSourceKey(input.currentUser.id),
      isSelf: true,
    },
    ...(input.channel.recipients ?? []).map((recipient) => ({
      sourceEntityKey: discordSourceKey(recipient.id),
      isSelf: false,
    })),
  ];

  return {
    id,
    platform: "discord",
    accountKey: input.accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    conversationExternalId: input.channel.id,
    observedAt: input.observedAt,
    dedupeKey: id,
    payload: {
      sourceConversationKey: discordConversationSourceKey(input.channel.id),
      conversationType: input.channel.type === 3 ? "group" : "dm",
      displayName,
      nativeConversationKey: input.channel.id,
      service: "discord",
      topic: input.channel.topic ?? null,
      participants,
    } satisfies ConversationObservationPayload,
    sourceVersion: "discord-v1",
  };
}

export function buildDiscordMessageEvent(input: {
  accountKey: string;
  observedAt: number;
  channel: DiscordChannel;
  message: DiscordMessage;
  currentUserId: string;
}): SyncBundle["rawEvents"][number] {
  const id = discordDedupeKey(
    `discord:message:${input.accountKey}:${input.message.channel_id}:${input.message.id}`,
  );
  const sentAt = discordTimestampMs(input.message.timestamp) ?? input.observedAt;
  const attachments =
    input.message.attachments?.map((attachment) => ({
      kind: "file",
      id: attachment.id,
      name: attachment.filename,
      mimetype: attachment.content_type ?? null,
      size: attachment.size ?? null,
      url: attachment.url ?? null,
      previewUrl: attachment.proxy_url ?? attachment.url ?? null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      access_kind: attachment.url ? "remote_url" : "none",
      access_ref: attachment.url ? { url: attachment.url } : null,
      preview_ref: attachment.proxy_url ? { url: attachment.proxy_url } : null,
      availability_status: attachment.url ? "available" : "metadata_only",
      provider_metadata: {
        proxyUrl: attachment.proxy_url ?? null,
      },
    })) ?? [];
  const fallbackContent =
    attachments
      .map((attachment) => String(attachment.name ?? ""))
      .filter((value) => value.length > 0)
      .join("\n") || "";

  return {
    id,
    platform: "discord",
    accountKey: input.accountKey,
    entityKind: "message",
    eventKind: "created",
    externalEntityId: input.message.id,
    conversationExternalId: input.message.channel_id,
    occurredAt: sentAt,
    observedAt: input.observedAt,
    dedupeKey: id,
    payload: {
      sourceMessageKey: discordMessageSourceKey(input.message.channel_id, input.message.id),
      sourceConversationKey: discordConversationSourceKey(input.message.channel_id),
      senderSourceKey:
        input.message.author.id === input.currentUserId
          ? null
          : discordSourceKey(input.message.author.id),
      sentAt,
      content: input.message.content || fallbackContent,
      service: "discord",
      status: null,
      isFromMe: input.message.author.id === input.currentUserId,
      editedAt: discordTimestampMs(input.message.edited_timestamp),
      isEdited: Boolean(input.message.edited_timestamp),
      replyToSourceMessageKey: input.message.message_reference?.message_id
        ? discordMessageSourceKey(
            input.message.message_reference.channel_id ?? input.message.channel_id,
            input.message.message_reference.message_id,
          )
        : null,
      attachments,
    } satisfies MessagePayload,
    sourceVersion: "discord-v1",
  };
}

export function buildDiscordConversationDisplayName(
  channel: DiscordChannel,
  currentUser: DiscordUser,
): string {
  if (channel.type === 1) {
    const recipient = (channel.recipients ?? []).find((user) => user.id !== currentUser.id);
    return recipient ? discordDisplayName(recipient) : "Discord DM";
  }

  if (channel.type === 3) {
    if (channel.name?.trim()) {
      return channel.name.trim();
    }
    const names = (channel.recipients ?? []).map((recipient) => discordDisplayName(recipient));
    return names.length > 0 ? names.join(", ") : "Discord Group DM";
  }

  return channel.name?.trim() || channel.id;
}
