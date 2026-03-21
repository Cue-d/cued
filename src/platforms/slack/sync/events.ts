import { createHash } from "node:crypto";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ReactionPayload,
} from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import type { SlackConversation, SlackMessage, SlackUser } from "../types.js";

export function slackDedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function slackSourceKey(teamId: string, userId: string): string {
  return `slack:${teamId}:${userId}`;
}

export function slackMessageKey(teamId: string, conversationId: string, messageTs: string): string {
  return `slack:${teamId}:${conversationId}:${messageTs}`;
}

export function slackTimestampMs(slackTs: string | undefined): number | null {
  if (!slackTs) return null;
  const parsed = Number(slackTs);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
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

export function buildSlackConversationDisplayName(
  conversation: SlackConversation,
  usersById: Map<string, SlackUser>,
  explicitDisplayName?: string | null,
): string {
  if (explicitDisplayName && explicitDisplayName.trim().length > 0) {
    return explicitDisplayName.trim();
  }

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

export function buildSlackContactEvents(
  teamId: string,
  accountKey: string,
  observedAt: number,
  users: SlackUser[],
): SyncBundle["rawEvents"] {
  return users.map((user) => {
    const contactId = slackDedupeKey(`slack:contact:${teamId}:${user.id}`);
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

export function buildSlackConversationEvent(input: {
  teamId: string;
  accountKey: string;
  conversation: SlackConversation;
  observedAt: number;
  memberIds: string[];
  selfUserId: string;
  usersById?: Map<string, SlackUser>;
  displayName?: string | null;
}): SyncBundle["rawEvents"][number] {
  const conversationId = slackDedupeKey(
    `slack:conversation:${input.teamId}:${input.conversation.id}`,
  );
  const usersById = input.usersById ?? new Map<string, SlackUser>();
  return {
    id: conversationId,
    platform: "slack",
    accountKey: input.accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    conversationExternalId: input.conversation.id,
    observedAt: input.observedAt,
    dedupeKey: conversationId,
    payload: {
      sourceConversationKey: `slack:${input.teamId}:${input.conversation.id}`,
      conversationType:
        input.conversation.is_mpim || input.conversation.is_channel || input.conversation.is_group
          ? "group"
          : "dm",
      displayName: buildSlackConversationDisplayName(
        input.conversation,
        usersById,
        input.displayName ?? null,
      ),
      nativeConversationKey: input.conversation.id,
      service: "slack",
      participants: input.memberIds.map((memberId) => ({
        sourceEntityKey: slackSourceKey(input.teamId, memberId),
        isSelf: memberId === input.selfUserId,
      })),
    } satisfies ConversationObservationPayload,
    sourceVersion: "slack-v1",
  };
}

export function buildSlackMessageEvents(input: {
  teamId: string;
  accountKey: string;
  conversationId: string;
  selfUserId: string;
  observedAt: number;
  messages: SlackMessage[];
}): SyncBundle["rawEvents"] {
  const rawEvents: SyncBundle["rawEvents"] = [];

  for (const message of input.messages) {
    const messageTsMs = slackTimestampMs(message.ts) ?? input.observedAt;
    const attachments = toAttachmentMetadata(message);
    const senderUserId = message.user ?? message.bot_id;
    const messageId = slackDedupeKey(
      `slack:message:${input.teamId}:${input.conversationId}:${message.ts}:${message.text ?? ""}:${message.edited?.ts ?? ""}`,
    );

    rawEvents.push({
      id: messageId,
      platform: "slack",
      accountKey: input.accountKey,
      entityKind: "message",
      eventKind: "created",
      externalEntityId: `${input.conversationId}:${message.ts}`,
      conversationExternalId: input.conversationId,
      occurredAt: messageTsMs,
      observedAt: input.observedAt,
      dedupeKey: messageId,
      payload: {
        sourceMessageKey: slackMessageKey(input.teamId, input.conversationId, message.ts),
        sourceConversationKey: `slack:${input.teamId}:${input.conversationId}`,
        senderSourceKey:
          senderUserId && senderUserId !== input.selfUserId
            ? slackSourceKey(input.teamId, senderUserId)
            : null,
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
        isFromMe: senderUserId === input.selfUserId,
        editedAt: slackTimestampMs(message.edited?.ts),
        isEdited: Boolean(message.edited?.ts),
        isDeleted: false,
        replyToSourceMessageKey:
          message.thread_ts && message.thread_ts !== message.ts
            ? slackMessageKey(input.teamId, input.conversationId, message.thread_ts)
            : null,
        attachments,
      } satisfies MessagePayload,
      sourceVersion: "slack-v1",
    });

    for (const reaction of message.reactions ?? []) {
      for (const reactorUserId of reaction.users) {
        const reactionId = slackDedupeKey(
          `slack:reaction:${input.teamId}:${input.conversationId}:${message.ts}:${reaction.name}:${reactorUserId}`,
        );
        rawEvents.push({
          id: reactionId,
          platform: "slack",
          accountKey: input.accountKey,
          entityKind: "reaction",
          eventKind: "added",
          externalEntityId: `${input.conversationId}:${message.ts}:${reaction.name}:${reactorUserId}`,
          conversationExternalId: input.conversationId,
          occurredAt: messageTsMs,
          observedAt: input.observedAt,
          dedupeKey: reactionId,
          payload: {
            sourceMessageKey: slackMessageKey(input.teamId, input.conversationId, message.ts),
            sourceConversationKey: `slack:${input.teamId}:${input.conversationId}`,
            reactorSourceKey:
              reactorUserId === input.selfUserId
                ? null
                : slackSourceKey(input.teamId, reactorUserId),
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
