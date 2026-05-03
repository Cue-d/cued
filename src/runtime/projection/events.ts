import {
  buildNormalizedRawEventSchema,
  type ParticipantPayload,
  type ProviderRawEventInput,
  type RawEventEntityKind,
  type RawEventPayload,
  type TimelineEventPayload,
} from "../../core/types/provider.js";

type StoredRawEvent = Pick<ProviderRawEventInput, "entityKind" | "eventKind"> & {
  normalizedSchema?: string | null;
};

export type NormalizedProjectedRawEvent = {
  entityKind: RawEventEntityKind;
  eventKind: string;
  normalizedSchema: string;
  payload: RawEventPayload;
};

const CANONICAL_SCHEMA_REGISTRY = {
  contact: new Set(["observed"]),
  conversation: new Set(["observed", "removed"]),
  call: new Set(["observed"]),
  message: new Set(["created", "updated", "deleted", "read_receipt"]),
  reaction: new Set(["added", "removed"]),
  participant: new Set(["joined", "left"]),
  timeline_event: new Set(["system_message"]),
} as const satisfies Record<RawEventEntityKind, ReadonlySet<string>>;

const SUPPORTED_NORMALIZED_SCHEMAS = new Set<string>(
  Object.entries(CANONICAL_SCHEMA_REGISTRY).flatMap(([entityKind, eventKinds]) =>
    [...eventKinds].map((eventKind) =>
      buildNormalizedRawEventSchema(entityKind as RawEventEntityKind, eventKind),
    ),
  ),
);

export function assertCanonicalNormalizedSchemaForWrite(schema: string): void {
  if (!SUPPORTED_NORMALIZED_SCHEMAS.has(schema)) {
    throw new Error(`New raw events must use canonical normalized schemas. Received '${schema}'.`);
  }
}

export function assertCanonicalRawEventPayloadForWrite(
  event: Pick<ProviderRawEventInput, "entityKind" | "eventKind" | "normalizedSchema" | "payload">,
): void {
  const normalizedSchema =
    event.normalizedSchema ?? buildNormalizedRawEventSchema(event.entityKind, event.eventKind);
  assertCanonicalNormalizedSchemaForWrite(normalizedSchema);
  assertObjectPayload(normalizedSchema, event.payload);
  switch (normalizedSchema) {
    case "contact.observed@1":
      assertStringField(normalizedSchema, event.payload, "sourceEntityKey");
      return;
    case "conversation.observed@1":
    case "conversation.removed@1":
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
      return;
    case "call.observed@1":
      assertStringField(normalizedSchema, event.payload, "sourceCallKey");
      assertNumberField(normalizedSchema, event.payload, "startedAt");
      return;
    case "message.created@1":
    case "message.updated@1":
    case "message.deleted@1":
    case "message.read_receipt@1":
      assertStringField(normalizedSchema, event.payload, "sourceMessageKey");
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
      return;
    case "reaction.added@1":
    case "reaction.removed@1":
      assertStringField(normalizedSchema, event.payload, "sourceMessageKey");
      assertStringField(normalizedSchema, event.payload, "emoji");
      return;
    case "participant.joined@1":
    case "participant.left@1":
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
      assertStringField(normalizedSchema, event.payload, "participantSourceKey");
      return;
    case "timeline_event.system_message@1":
      assertStringField(normalizedSchema, event.payload, "sourceEventKey");
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
      return;
    default:
      throw new Error(`Unsupported canonical raw event schema '${normalizedSchema}'`);
  }
}

function assertObjectPayload(
  schema: string,
  payload: RawEventPayload,
): asserts payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Raw event payload for '${schema}' must be an object.`);
  }
}

function assertStringField(schema: string, payload: Record<string, unknown>, field: string): void {
  if (typeof payload[field] !== "string" || payload[field].trim().length === 0) {
    throw new Error(`Raw event payload for '${schema}' must include string field '${field}'.`);
  }
}

function assertNumberField(schema: string, payload: Record<string, unknown>, field: string): void {
  if (typeof payload[field] !== "number" || !Number.isFinite(payload[field])) {
    throw new Error(`Raw event payload for '${schema}' must include number field '${field}'.`);
  }
}

function parseNormalizedSchema(schema: string): {
  entityKind: RawEventEntityKind;
  eventKind: string;
} {
  const match =
    /^(contact|conversation|call|message|reaction|participant|timeline_event)\.([a-z_]+)@1$/.exec(
      schema,
    );
  if (!match) {
    throw new Error(`Unsupported normalized raw event schema '${schema}'`);
  }
  return {
    entityKind: match[1] as RawEventEntityKind,
    eventKind: match[2] ?? "",
  };
}

function buildSystemMessagePayload(
  payload: RawEventPayload,
  legacyEventKind: string,
): TimelineEventPayload {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "sourceEventKey" in payload &&
    typeof payload.sourceEventKey === "string" &&
    "sourceConversationKey" in payload &&
    typeof payload.sourceConversationKey === "string" &&
    "eventAt" in payload &&
    typeof payload.eventAt === "number"
  ) {
    const timelinePayload = payload as TimelineEventPayload;
    return {
      ...timelinePayload,
      eventKind: "system_message",
      metadata: {
        ...(timelinePayload.metadata ?? {}),
        legacyEventKind,
      },
    };
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "sourceMessageKey" in payload &&
    typeof payload.sourceMessageKey === "string" &&
    "sourceConversationKey" in payload &&
    typeof payload.sourceConversationKey === "string" &&
    "sentAt" in payload &&
    typeof payload.sentAt === "number"
  ) {
    const messagePayload = payload as Record<string, unknown>;
    return {
      sourceEventKey: String(messagePayload.sourceMessageKey),
      sourceConversationKey: String(messagePayload.sourceConversationKey),
      eventKind: "system_message",
      eventAt: Number(messagePayload.sentAt),
      text: typeof messagePayload.content === "string" ? messagePayload.content : null,
      metadata: {
        legacyEventKind,
        sourceMessageKey: messagePayload.sourceMessageKey,
      },
    };
  }

  throw new Error(
    `Unable to upcast payload for legacy normalized raw event schema '${legacyEventKind}'`,
  );
}

function buildParticipantPayload(
  payload: RawEventPayload,
  eventKind: "joined" | "left",
): ParticipantPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("sourceConversationKey" in payload) ||
    typeof payload.sourceConversationKey !== "string"
  ) {
    throw new Error(`Unable to upcast payload for legacy participant schema '${eventKind}'`);
  }
  const timelinePayload = payload as TimelineEventPayload;
  const participantSourceKey =
    typeof timelinePayload.subjectSourceKey === "string" &&
    timelinePayload.subjectSourceKey.length > 0
      ? timelinePayload.subjectSourceKey
      : typeof timelinePayload.actorSourceKey === "string" &&
          timelinePayload.actorSourceKey.length > 0
        ? timelinePayload.actorSourceKey
        : "";
  if (!participantSourceKey) {
    throw new Error(`Unable to upcast payload for legacy participant schema '${eventKind}'`);
  }
  return {
    sourceConversationKey: timelinePayload.sourceConversationKey,
    participantSourceKey,
    eventAt: timelinePayload.eventAt,
    metadata: {
      ...(timelinePayload.metadata ?? {}),
      legacyTimelineEventKind: timelinePayload.eventKind,
    },
  };
}

function canonicalizeProjectedSchema(
  normalizedSchema: string,
  payload: RawEventPayload,
): NormalizedProjectedRawEvent {
  switch (normalizedSchema) {
    case "message.message_created@1":
      return {
        entityKind: "message",
        eventKind: "created",
        normalizedSchema: buildNormalizedRawEventSchema("message", "created"),
        payload,
      };
    case "message.message_updated@1":
      return {
        entityKind: "message",
        eventKind: "updated",
        normalizedSchema: buildNormalizedRawEventSchema("message", "updated"),
        payload,
      };
    case "message.message_deleted@1":
      return {
        entityKind: "message",
        eventKind: "deleted",
        normalizedSchema: buildNormalizedRawEventSchema("message", "deleted"),
        payload,
      };
    case "message.message_read_receipt@1":
      return {
        entityKind: "message",
        eventKind: "read_receipt",
        normalizedSchema: buildNormalizedRawEventSchema("message", "read_receipt"),
        payload,
      };
    case "message.message_observed@1":
      return {
        entityKind: "timeline_event",
        eventKind: "system_message",
        normalizedSchema: buildNormalizedRawEventSchema("timeline_event", "system_message"),
        payload: buildSystemMessagePayload(payload, "message_observed"),
      };
    case "reaction.created@1": {
      const reactionEventKind =
        typeof payload === "object" &&
        payload !== null &&
        "isActive" in payload &&
        payload.isActive === false
          ? "removed"
          : "added";
      return {
        entityKind: "reaction",
        eventKind: reactionEventKind,
        normalizedSchema: buildNormalizedRawEventSchema("reaction", reactionEventKind),
        payload,
      };
    }
    case "reaction.reaction_added@1":
      return {
        entityKind: "reaction",
        eventKind: "added",
        normalizedSchema: buildNormalizedRawEventSchema("reaction", "added"),
        payload,
      };
    case "reaction.reaction_removed@1":
      return {
        entityKind: "reaction",
        eventKind: "removed",
        normalizedSchema: buildNormalizedRawEventSchema("reaction", "removed"),
        payload,
      };
    case "timeline_event.linkedin_system_message@1":
      return {
        entityKind: "timeline_event",
        eventKind: "system_message",
        normalizedSchema: buildNormalizedRawEventSchema("timeline_event", "system_message"),
        payload: buildSystemMessagePayload(payload, "linkedin_system_message"),
      };
    case "timeline_event.linkedin_group_read_receipt@1":
      return {
        entityKind: "timeline_event",
        eventKind: "system_message",
        normalizedSchema: buildNormalizedRawEventSchema("timeline_event", "system_message"),
        payload: buildSystemMessagePayload(payload, "linkedin_group_read_receipt"),
      };
    case "timeline_event.linkedin_conversation_removed@1":
      return {
        entityKind: "timeline_event",
        eventKind: "system_message",
        normalizedSchema: buildNormalizedRawEventSchema("timeline_event", "system_message"),
        payload: buildSystemMessagePayload(payload, "linkedin_conversation_removed"),
      };
    case "timeline_event.participant_joined@1":
      return {
        entityKind: "participant",
        eventKind: "joined",
        normalizedSchema: buildNormalizedRawEventSchema("participant", "joined"),
        payload: buildParticipantPayload(payload, "joined"),
      };
    case "timeline_event.participant_left@1":
      return {
        entityKind: "participant",
        eventKind: "left",
        normalizedSchema: buildNormalizedRawEventSchema("participant", "left"),
        payload: buildParticipantPayload(payload, "left"),
      };
    default: {
      const parsed = parseNormalizedSchema(normalizedSchema);
      if (!SUPPORTED_NORMALIZED_SCHEMAS.has(normalizedSchema)) {
        throw new Error(`Unsupported normalized raw event schema '${normalizedSchema}'`);
      }
      return {
        entityKind: parsed.entityKind,
        eventKind: parsed.eventKind,
        normalizedSchema,
        payload,
      };
    }
  }
}

export function normalizeStoredRawEventForProjection(
  event: StoredRawEvent,
  payload: RawEventPayload,
): NormalizedProjectedRawEvent {
  const normalizedSchema =
    event.normalizedSchema?.trim() ||
    buildNormalizedRawEventSchema(event.entityKind, event.eventKind);
  return canonicalizeProjectedSchema(normalizedSchema, payload);
}
