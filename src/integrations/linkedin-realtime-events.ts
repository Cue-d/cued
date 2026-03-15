import type {
  Conversation,
  Message,
  RealtimeEventEnvelope,
  RealtimeReaction,
  SeenReceipt,
} from "../adapters/linkedin/api/types.js";
import type { ProviderRawEventInput } from "../types/provider.js";
import {
  buildLinkedInConversationEvent,
  buildLinkedInConversationRemovalEvents,
  buildLinkedInGroupReceiptTimelineEvent,
  buildLinkedInMessageEvent,
  buildLinkedInReactionEvent,
  buildLinkedInSystemTimelineEvent,
  buildParticipantContactEvent,
  extractReactionTimestamp,
  normalizeMemberUrn,
} from "./linkedin-events.js";

function topicName(topic: string | undefined): string | null {
  if (!topic) {
    return null;
  }
  const parts = topic.split(":");
  return parts.length >= 3 ? parts[2] ?? null : topic;
}

function pushUniqueContactEvent(
  rawEvents: ProviderRawEventInput[],
  seenContactIds: Set<string>,
  accountKey: string,
  observedAt: number,
  participant: Message["sender"] | SeenReceipt["seenByParticipant"] | RealtimeReaction["actor"],
): void {
  const event = buildParticipantContactEvent(accountKey, participant, observedAt);
  if (seenContactIds.has(event.id)) {
    return;
  }
  seenContactIds.add(event.id);
  rawEvents.push(event);
}

function pushConversationContext(
  rawEvents: ProviderRawEventInput[],
  seenContactIds: Set<string>,
  accountKey: string,
  userEntityUrn: string,
  observedAt: number,
  conversation: Conversation | null | undefined,
): void {
  if (!conversation) {
    return;
  }
  for (const participant of conversation.conversationParticipants) {
    if (normalizeMemberUrn(participant.entityURN) === userEntityUrn) {
      continue;
    }
    pushUniqueContactEvent(rawEvents, seenContactIds, accountKey, observedAt, participant);
  }
  rawEvents.push(buildLinkedInConversationEvent(accountKey, conversation, userEntityUrn, observedAt));
}

export function buildLinkedInRawEventsFromRealtimeEnvelope(input: {
  accountKey: string;
  userEntityUrn: string;
  envelope: RealtimeEventEnvelope;
}): ProviderRawEventInput[] {
  const decorated = input.envelope["com.linkedin.realtimefrontend.DecoratedEvent"];
  if (!decorated) {
    return [];
  }

  const observedAt =
    typeof decorated.leftServerAt === "number" && Number.isFinite(decorated.leftServerAt)
      ? decorated.leftServerAt
      : Date.now();
  const rawEvents: ProviderRawEventInput[] = [];
  const seenContactIds = new Set<string>();
  const topic = topicName(decorated.topic);
  const data = decorated.payload?.data;

  switch (topic) {
    case "conversationsTopic": {
      const conversation = data?.doDecorateConversationMessengerRealtimeDecoration?.result;
      if (!conversation) {
        return [];
      }
      pushConversationContext(
        rawEvents,
        seenContactIds,
        input.accountKey,
        input.userEntityUrn,
        observedAt,
        conversation,
      );
      return rawEvents;
    }
    case "conversationDeletesTopic": {
      const conversation = data?.doDecorateConversationDeleteMessengerRealtimeDecoration?.result;
      if (!conversation?.entityURN) {
        return [];
      }
      return buildLinkedInConversationRemovalEvents({
        accountKey: input.accountKey,
        conversationUrn: conversation.entityURN,
        observedAt,
        reason: "deleted",
        conversation,
      });
    }
    case "messagesTopic": {
      const message = data?.doDecorateMessageMessengerRealtimeDecoration?.result;
      if (!message?.entityURN) {
        return [];
      }
      pushConversationContext(
        rawEvents,
        seenContactIds,
        input.accountKey,
        input.userEntityUrn,
        observedAt,
        message.conversation,
      );
      pushUniqueContactEvent(rawEvents, seenContactIds, input.accountKey, observedAt, message.sender);
      rawEvents.push(
        message.messageBodyRenderFormat === "SYSTEM"
          ? buildLinkedInSystemTimelineEvent(input.accountKey, message, observedAt)
          : buildLinkedInMessageEvent({
              accountKey: input.accountKey,
              message,
              fallbackConversationUrn:
                message.conversationURN || message.conversation?.entityURN || "",
              userEntityUrn: input.userEntityUrn,
              observedAt,
            }),
      );
      return rawEvents;
    }
    case "messageReactionSummariesTopic": {
      const reaction = data?.doDecorateRealtimeReactionSummaryMessengerRealtimeDecoration?.result;
      if (!reaction?.message?.entityURN) {
        return [];
      }
      pushConversationContext(
        rawEvents,
        seenContactIds,
        input.accountKey,
        input.userEntityUrn,
        observedAt,
        reaction.message.conversation,
      );
      pushUniqueContactEvent(rawEvents, seenContactIds, input.accountKey, observedAt, reaction.actor);
      rawEvents.push(
        buildLinkedInReactionEvent({
          accountKey: input.accountKey,
          message: reaction.message,
          conversationUrn:
            reaction.message.conversationURN || reaction.message.conversation?.entityURN || "",
          reactor: reaction.actor,
          emoji: reaction.reactionSummary.emoji,
          observedAt,
          timestamp: extractReactionTimestamp(reaction.reactionSummary, observedAt),
          isActive: reaction.reactionAdded,
        }),
      );
      return rawEvents;
    }
    case "messageSeenReceiptsTopic": {
      const receipt = data?.doDecorateSeenReceiptMessengerRealtimeDecoration?.result;
      if (!receipt?.message?.entityURN) {
        return [];
      }
      pushConversationContext(
        rawEvents,
        seenContactIds,
        input.accountKey,
        input.userEntityUrn,
        observedAt,
        receipt.message.conversation,
      );
      pushUniqueContactEvent(
        rawEvents,
        seenContactIds,
        input.accountKey,
        observedAt,
        receipt.seenByParticipant,
      );

      if (receipt.message.conversation?.groupChat) {
        rawEvents.push(
          buildLinkedInGroupReceiptTimelineEvent({
            accountKey: input.accountKey,
            receipt,
            observedAt,
          }),
        );
        return rawEvents;
      }

      rawEvents.push(
        buildLinkedInMessageEvent({
          accountKey: input.accountKey,
          message: receipt.message,
          fallbackConversationUrn:
            receipt.message.conversationURN || receipt.message.conversation?.entityURN || "",
          userEntityUrn: input.userEntityUrn,
          observedAt,
          eventKind: "message_read_receipt",
          readAt: receipt.seenAt,
          status: "read",
        }),
      );
      return rawEvents;
    }
    default:
      return [];
  }
}
