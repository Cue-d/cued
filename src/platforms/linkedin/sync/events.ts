import { createHash } from "node:crypto";
import type {
  ContactHandleInput,
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ProviderRawEventInput,
  ReactionPayload,
  TimelineEventPayload,
} from "../../../core/types/provider.js";
import type {
  Conversation,
  Message,
  MessagingParticipant,
  ReactionSummary,
  SeenReceipt,
} from "../api/types.js";

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function normalizeConversationUrn(urn: string): string {
  return urn
    .replace(/^urn:li:fsd_conversation:/, "urn:li:fs_conversation:")
    .replace(/^urn:li:msg_conversation:/, "urn:li:fs_conversation:")
    .replace(/^urn:li:messagingThread:/, "urn:li:fs_conversation:");
}

export function normalizeMemberUrn(urn: string): string {
  const nested = urn.match(/^urn:li:msg_messagingparticipant:(.+)$/i)?.[1];
  const base = nested ?? urn;
  const id = base.match(/^urn:li:[^:]+:(.+)$/)?.[1];
  return id ? `urn:li:member:${id}` : base;
}

export function extractUrnId(urn: string | undefined): string | null {
  if (!urn) {
    return null;
  }
  const match = urn.match(/^urn:li:[^:]+:(.+)$/);
  return match?.[1] ?? null;
}

export function linkedinProfileUrlFromUrn(urn: string | undefined): string | null {
  const id = extractUrnId(urn);
  if (!id || /^ACo/i.test(id)) {
    return null;
  }
  return `https://www.linkedin.com/in/${id}`;
}

export function participantSourceKey(participant: Pick<MessagingParticipant, "entityURN">): string {
  return `linkedin:${normalizeMemberUrn(participant.entityURN)}`;
}

export function bestParticipantName(participant: MessagingParticipant): string {
  if (participant.participantType.member) {
    return [
      participant.participantType.member.firstName,
      participant.participantType.member.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return participant.participantType.organization?.name ?? participant.entityURN;
}

export function bestParticipantPhoto(participant: MessagingParticipant): string | null {
  return (
    participant.participantType.member?.picture?.url ??
    participant.participantType.organization?.logoUrl ??
    null
  );
}

export function participantHandles(participant: MessagingParticipant): ContactHandleInput[] {
  const handles: ContactHandleInput[] = [
    {
      type: "linkedin_entity_urn",
      value: normalizeMemberUrn(participant.entityURN),
      deterministic: true,
    },
  ];
  const profileUrl =
    participant.participantType.member?.profileUrl ||
    linkedinProfileUrlFromUrn(participant.entityURN);
  if (profileUrl) {
    handles.push({
      type: "linkedin_profile_url",
      value: profileUrl,
      deterministic: true,
    });
  }
  const profileId = extractUrnId(participant.entityURN);
  if (profileId) {
    handles.push({
      type: "linkedin_profile_id",
      value: profileId,
      deterministic: true,
    });
  }
  return handles;
}

export function buildParticipantContactEvent(
  accountKey: string,
  participant: MessagingParticipant,
  observedAt: number,
): ProviderRawEventInput<ContactObservationPayload> {
  const normalizedParticipantUrn = normalizeMemberUrn(participant.entityURN);
  const id = stableId(
    `linkedin:participant:${accountKey}:${normalizedParticipantUrn}:${bestParticipantName(participant)}:${participant.participantType.member?.headline ?? ""}`,
  );
  return {
    id,
    platform: "linkedin",
    accountKey,
    entityKind: "contact",
    eventKind: "observed",
    externalEntityId: normalizedParticipantUrn,
    observedAt,
    dedupeKey: id,
    payload: {
      sourceEntityKey: participantSourceKey(participant),
      fields: {
        display_name: bestParticipantName(participant),
        company: participant.participantType.member?.headline ?? null,
        photo_url: bestParticipantPhoto(participant),
      },
      sourceProfileUrl:
        participant.participantType.member?.profileUrl ??
        linkedinProfileUrlFromUrn(participant.entityURN),
      handles: participantHandles(participant),
    },
    sourceVersion: "linkedin-v1",
  };
}

function largestVectorImageUrl(value: unknown): string | null {
  const image =
    typeof value === "object" && value !== null
      ? (value as {
          rootUrl?: unknown;
          artifacts?: Array<{
            width?: unknown;
            height?: unknown;
            fileIdentifyingUrlPathSegment?: unknown;
          }>;
        })
      : null;
  if (!image || typeof image.rootUrl !== "string" || !Array.isArray(image.artifacts)) {
    return null;
  }
  const artifact = image.artifacts.reduce<
    | {
        width?: unknown;
        fileIdentifyingUrlPathSegment?: unknown;
      }
    | undefined
  >((largest, current) => {
    const largestWidth = typeof largest?.width === "number" ? largest.width : 0;
    const currentWidth = typeof current.width === "number" ? current.width : 0;
    return largestWidth > currentWidth ? largest : current;
  }, undefined);
  if (!artifact || typeof artifact.fileIdentifyingUrlPathSegment !== "string") {
    return null;
  }
  return `${image.rootUrl}${artifact.fileIdentifyingUrlPathSegment}`;
}

export function replyToSourceMessageKey(message: Message): string | null {
  for (const item of message.renderContent ?? []) {
    const originalUrn = item.repliedMessageContent?.originalMessage?.entityUrn;
    if (typeof originalUrn === "string" && originalUrn.length > 0) {
      return `linkedin:${originalUrn}`;
    }
  }
  return null;
}

export function normalizeLinkedInAttachments(message: Message): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  for (const [index, item] of (message.renderContent ?? []).entries()) {
    if (item.repliedMessageContent) {
      continue;
    }

    if (item.file && typeof item.file === "object") {
      const file = item.file as Record<string, unknown>;
      attachments.push({
        sourceAttachmentKey: `${message.entityURN}:file:${file.assetUrn ?? index}`,
        kind: "file",
        id: file.assetUrn ?? null,
        filename: file.name ?? null,
        mime_type: file.mediaType ?? null,
        size_bytes: file.byteSize ?? null,
        remote_url: file.url ?? null,
        metadata: file,
      });
      continue;
    }

    if (item.audio && typeof item.audio === "object") {
      const audio = item.audio as Record<string, unknown>;
      attachments.push({
        sourceAttachmentKey: `${message.entityURN}:audio:${audio.assetUrn ?? index}`,
        kind: "audio",
        id: audio.assetUrn ?? null,
        remote_url: audio.url ?? null,
        size_bytes: audio.byteSize ?? null,
        duration_ms: audio.duration ?? null,
        metadata: audio,
      });
      continue;
    }

    if (item.video && typeof item.video === "object") {
      const video = item.video as Record<string, unknown>;
      const streams = Array.isArray(video.progressiveStreams)
        ? (video.progressiveStreams as Array<Record<string, unknown>>)
        : [];
      const firstStream = streams[0];
      const locations = Array.isArray(firstStream?.streamingLocations)
        ? (firstStream.streamingLocations as Array<Record<string, unknown>>)
        : [];
      attachments.push({
        sourceAttachmentKey: `${message.entityURN}:video:${video.media ?? index}`,
        kind: "video",
        id: video.media ?? null,
        remote_url: locations.find((location) => typeof location.url === "string")?.url ?? null,
        mime_type: firstStream?.mediaType ?? null,
        size_bytes: firstStream?.size ?? null,
        preview_url: largestVectorImageUrl(video.thumbnail ?? null),
        metadata: video,
      });
      continue;
    }

    if (item.vectorImage) {
      attachments.push({
        sourceAttachmentKey: `${message.entityURN}:image:${index}`,
        kind: "image",
        remote_url: largestVectorImageUrl(item.vectorImage),
        metadata: item.vectorImage,
      });
      continue;
    }

    if (item.externalMedia && typeof item.externalMedia === "object") {
      const media = item.externalMedia as Record<string, unknown>;
      const payload = media.media as Record<string, unknown> | undefined;
      attachments.push({
        sourceAttachmentKey: `${message.entityURN}:external:${media.entityUrn ?? index}`,
        kind: "link",
        title: media.title ?? null,
        remote_url: payload?.url ?? null,
        preview_url:
          typeof (media.previewMedia as Record<string, unknown> | undefined)?.url === "string"
            ? (media.previewMedia as Record<string, unknown>).url
            : null,
        metadata: media,
      });
      continue;
    }

    attachments.push({
      sourceAttachmentKey: `${message.entityURN}:attachment:${index}`,
      kind: "attachment",
      metadata: item,
    });
  }
  return attachments;
}

export function isLinkedInMessageDeleted(message: Message): boolean {
  return message.messageBodyRenderFormat === "RECALLED";
}

export function isLinkedInMessageEdited(message: Message): boolean {
  return message.messageBodyRenderFormat === "EDITED";
}

export function isLinkedInSystemMessage(message: Message): boolean {
  return message.messageBodyRenderFormat === "SYSTEM";
}

export function conversationSourceKey(conversationUrn: string): string {
  return `linkedin:${normalizeConversationUrn(conversationUrn)}`;
}

export function messageSourceKey(messageUrn: string): string {
  return `linkedin:${messageUrn}`;
}

export function buildLinkedInConversationEvent(
  accountKey: string,
  conversation: Conversation,
  userEntityUrn: string,
  observedAt: number,
): ProviderRawEventInput<ConversationObservationPayload> {
  const normalizedConversation = normalizeConversationUrn(conversation.entityURN);
  const id = stableId(
    `linkedin:conversation:${accountKey}:${normalizedConversation}:${conversation.title}:${conversation.conversationParticipants
      .map((participant) => participantSourceKey(participant))
      .join(",")}`,
  );
  return {
    id,
    platform: "linkedin",
    accountKey,
    entityKind: "conversation",
    eventKind: "observed",
    externalEntityId: normalizedConversation,
    conversationExternalId: normalizedConversation,
    occurredAt: conversation.lastActivityAt,
    observedAt,
    dedupeKey: id,
    payload: {
      sourceConversationKey: conversationSourceKey(normalizedConversation),
      conversationType: conversation.groupChat ? "group" : "dm",
      displayName: conversation.title || null,
      nativeConversationKey: normalizedConversation,
      subtype: null,
      service: "linkedin",
      unreadCount: conversation.unreadCount,
      participants: conversation.conversationParticipants.map((participant) => ({
        sourceEntityKey: participantSourceKey(participant),
        isSelf: normalizeMemberUrn(participant.entityURN) === userEntityUrn,
      })),
    },
    sourceVersion: "linkedin-v1",
  };
}

export function buildLinkedInConversationRemovalEvents(input: {
  accountKey: string;
  conversationUrn: string;
  observedAt: number;
  reason: string;
  conversation?: Conversation | null;
  userEntityUrn?: string | null;
}): ProviderRawEventInput[] {
  const normalizedConversation = normalizeConversationUrn(input.conversationUrn);
  const sourceConversationKey = conversationSourceKey(normalizedConversation);
  const removalId = stableId(
    `linkedin:conversation:removed:${input.accountKey}:${sourceConversationKey}:${input.reason}:${input.observedAt}`,
  );
  return [
    {
      id: removalId,
      platform: "linkedin",
      accountKey: input.accountKey,
      entityKind: "conversation",
      eventKind: "removed",
      externalEntityId: normalizedConversation,
      conversationExternalId: normalizedConversation,
      occurredAt: input.observedAt,
      observedAt: input.observedAt,
      dedupeKey: removalId,
      payload: {
        sourceConversationKey,
        conversationType: input.conversation?.groupChat ? "group" : "dm",
        displayName: input.conversation?.title || null,
        nativeConversationKey: normalizedConversation,
        subtype: "deleted",
        service: "linkedin",
        unreadCount: 0,
        participants:
          input.conversation?.conversationParticipants.map((participant) => ({
            sourceEntityKey: participantSourceKey(participant),
            isSelf: input.userEntityUrn
              ? normalizeMemberUrn(participant.entityURN) === input.userEntityUrn
              : undefined,
          })) ?? [],
      } satisfies ConversationObservationPayload,
      sourceVersion: "linkedin-v1",
    },
    {
      id: `${removalId}:timeline`,
      platform: "linkedin",
      accountKey: input.accountKey,
      entityKind: "timeline_event",
      eventKind: "linkedin_conversation_removed",
      externalEntityId: `${normalizedConversation}:removed`,
      conversationExternalId: normalizedConversation,
      occurredAt: input.observedAt,
      observedAt: input.observedAt,
      dedupeKey: `${removalId}:timeline`,
      payload: {
        sourceEventKey: `${sourceConversationKey}:removed:${input.reason}:${input.observedAt}`,
        sourceConversationKey,
        eventKind: "linkedin_conversation_removed",
        eventAt: input.observedAt,
        text: `LinkedIn marked this conversation as ${input.reason}.`,
        metadata: {
          reason: input.reason,
        },
      } satisfies TimelineEventPayload,
      sourceVersion: "linkedin-v1",
    },
  ];
}

export function buildLinkedInSystemTimelineEvent(
  accountKey: string,
  message: Message,
  observedAt: number,
): ProviderRawEventInput<TimelineEventPayload> {
  const sourceConversationKey = conversationSourceKey(message.conversationURN);
  const sender = message.sender?.entityURN ? participantSourceKey(message.sender) : null;
  return {
    id: stableId(
      `linkedin:timeline:system:${accountKey}:${message.entityURN}:${message.deliveredAt}`,
    ),
    platform: "linkedin",
    accountKey,
    entityKind: "timeline_event",
    eventKind: "linkedin_system_message",
    externalEntityId: message.entityURN,
    conversationExternalId: normalizeConversationUrn(message.conversationURN),
    occurredAt: message.deliveredAt,
    observedAt,
    dedupeKey: stableId(`linkedin:timeline:system:${accountKey}:${message.entityURN}`),
    payload: {
      sourceEventKey: `linkedin:system:${message.entityURN}`,
      sourceConversationKey,
      eventKind: "linkedin_system_message",
      actorSourceKey: sender,
      eventAt: message.deliveredAt,
      text: message.body.text || null,
      metadata: {
        renderFormat: message.messageBodyRenderFormat,
        renderContent: message.renderContent ?? [],
      },
    },
    sourceVersion: "linkedin-v1",
  };
}

export function buildLinkedInMessageEvent(input: {
  accountKey: string;
  message: Message;
  fallbackConversationUrn: string;
  userEntityUrn: string;
  observedAt: number;
  eventKind?: string;
  readAt?: number | null;
  status?: string | null;
}): ProviderRawEventInput<MessagePayload> {
  const conversationUrn = input.message.conversationURN || input.fallbackConversationUrn;
  const normalizedConversation = normalizeConversationUrn(conversationUrn);
  const senderUrn = normalizeMemberUrn(input.message.sender.entityURN);
  const isDeleted = isLinkedInMessageDeleted(input.message);
  const isEdited = isLinkedInMessageEdited(input.message);
  const id = stableId(
    `linkedin:message:${input.accountKey}:${normalizedConversation}:${input.message.entityURN}:${input.message.body.text}:${input.message.messageBodyRenderFormat}:${input.readAt ?? ""}`,
  );
  return {
    id,
    platform: "linkedin",
    accountKey: input.accountKey,
    entityKind: "message",
    eventKind: input.eventKind ?? "message_created",
    externalEntityId: input.message.entityURN,
    conversationExternalId: normalizedConversation,
    occurredAt: input.message.deliveredAt,
    observedAt: input.observedAt,
    dedupeKey: id,
    payload: {
      sourceMessageKey: messageSourceKey(input.message.entityURN),
      sourceConversationKey: conversationSourceKey(normalizedConversation),
      senderSourceKey: senderUrn === input.userEntityUrn ? null : `linkedin:${senderUrn}`,
      sentAt: input.message.deliveredAt,
      content: isDeleted ? "" : input.message.body.text,
      service: "linkedin",
      status: input.status ?? (input.readAt ? "read" : "delivered"),
      isFromMe: senderUrn === input.userEntityUrn,
      deliveredAt: input.message.deliveredAt,
      readAt: input.readAt ?? null,
      editedAt: isEdited ? input.message.deliveredAt : null,
      deletedAt: isDeleted ? input.message.deliveredAt : null,
      replyToSourceMessageKey: replyToSourceMessageKey(input.message),
      isEdited,
      isDeleted,
      attachments: normalizeLinkedInAttachments(input.message),
    },
    sourceVersion: "linkedin-v1",
  };
}

export function buildLinkedInReactionEvent(input: {
  accountKey: string;
  message: Message;
  conversationUrn: string;
  reactor: MessagingParticipant | null;
  emoji: string;
  observedAt: number;
  timestamp?: number | null;
  isActive: boolean;
}): ProviderRawEventInput<ReactionPayload> {
  const sourceMessageKey = messageSourceKey(input.message.entityURN);
  const sourceConversationKey = conversationSourceKey(input.conversationUrn);
  const reactorSourceKey = input.reactor ? participantSourceKey(input.reactor) : null;
  const transitionTime = input.timestamp ?? input.observedAt;
  const id = stableId(
    `linkedin:reaction:${input.accountKey}:${sourceMessageKey}:${reactorSourceKey ?? "__me__"}:${input.emoji}:${input.isActive}:${transitionTime}`,
  );
  return {
    id,
    platform: "linkedin",
    accountKey: input.accountKey,
    entityKind: "reaction",
    eventKind: input.isActive ? "reaction_added" : "reaction_removed",
    externalEntityId: `${sourceMessageKey}:${reactorSourceKey ?? "__me__"}:${input.emoji}`,
    conversationExternalId: normalizeConversationUrn(input.conversationUrn),
    occurredAt: transitionTime,
    observedAt: input.observedAt,
    dedupeKey: id,
    payload: {
      sourceMessageKey,
      sourceConversationKey,
      reactorSourceKey,
      emoji: input.emoji,
      timestamp: transitionTime,
      isActive: input.isActive,
    },
    sourceVersion: "linkedin-v1",
  };
}

export function buildLinkedInGroupReceiptTimelineEvent(input: {
  accountKey: string;
  receipt: SeenReceipt;
  observedAt: number;
}): ProviderRawEventInput<TimelineEventPayload> {
  const conversationUrn =
    input.receipt.message.conversationURN || input.receipt.message.conversation?.entityURN || "";
  const sourceConversationKey = conversationSourceKey(conversationUrn);
  const actorSourceKey = participantSourceKey(input.receipt.seenByParticipant);
  return {
    id: stableId(
      `linkedin:timeline:receipt:${input.accountKey}:${input.receipt.message.entityURN}:${actorSourceKey}:${input.receipt.seenAt}`,
    ),
    platform: "linkedin",
    accountKey: input.accountKey,
    entityKind: "timeline_event",
    eventKind: "linkedin_group_read_receipt",
    externalEntityId: `${input.receipt.message.entityURN}:${actorSourceKey}:${input.receipt.seenAt}`,
    conversationExternalId: normalizeConversationUrn(conversationUrn),
    occurredAt: input.receipt.seenAt,
    observedAt: input.observedAt,
    dedupeKey: stableId(
      `linkedin:timeline:receipt:${input.accountKey}:${input.receipt.message.entityURN}:${actorSourceKey}:${input.receipt.seenAt}`,
    ),
    payload: {
      sourceEventKey: `linkedin:receipt:${input.receipt.message.entityURN}:${actorSourceKey}:${input.receipt.seenAt}`,
      sourceConversationKey,
      eventKind: "linkedin_group_read_receipt",
      actorSourceKey,
      eventAt: input.receipt.seenAt,
      text: `${bestParticipantName(input.receipt.seenByParticipant)} read a message.`,
      metadata: {
        sourceMessageKey: messageSourceKey(input.receipt.message.entityURN),
        seenAt: input.receipt.seenAt,
      },
    },
    sourceVersion: "linkedin-v1",
  };
}

export function extractReactionTimestamp(
  summary: ReactionSummary | undefined,
  fallback: number,
): number {
  return typeof summary?.firstReactedAt === "number" ? summary.firstReactedAt : fallback;
}
