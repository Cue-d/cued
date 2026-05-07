import {
  buildNormalizedRawEventSchema,
  type ProviderRawEventInput,
  type RawEventEntityKind,
  type RawEventPayload,
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
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
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
      assertStringField(normalizedSchema, event.payload, "sourceConversationKey");
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

function normalizeCanonicalSchema(
  normalizedSchema: string,
  payload: RawEventPayload,
): NormalizedProjectedRawEvent {
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

export function normalizeStoredRawEventForProjection(
  event: StoredRawEvent,
  payload: RawEventPayload,
): NormalizedProjectedRawEvent {
  const normalizedSchema =
    event.normalizedSchema?.trim() ||
    buildNormalizedRawEventSchema(event.entityKind, event.eventKind);
  return normalizeCanonicalSchema(normalizedSchema, payload);
}
