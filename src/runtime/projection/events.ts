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

function parseNormalizedSchema(schema: string): {
  entityKind: RawEventEntityKind;
  eventKind: string;
} {
  const match =
    /^(contact|conversation|message|reaction|participant|timeline_event)\.([a-z_]+)@1$/.exec(
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

export function normalizeStoredRawEventForProjection(
  event: StoredRawEvent,
  payload: RawEventPayload,
): NormalizedProjectedRawEvent {
  const normalizedSchema =
    event.normalizedSchema?.trim() ||
    buildNormalizedRawEventSchema(event.entityKind, event.eventKind);
  const parsed = parseNormalizedSchema(normalizedSchema);
  assertCanonicalNormalizedSchemaForWrite(normalizedSchema);
  return {
    entityKind: parsed.entityKind,
    eventKind: parsed.eventKind,
    normalizedSchema,
    payload,
  };
}
