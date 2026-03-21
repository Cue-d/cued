import {
  buildNormalizedRawEventSchema,
  type ProviderRawEventInput,
  type RawEventPayload,
} from "../../core/types/provider.js";

type StoredRawEvent = Pick<ProviderRawEventInput, "entityKind" | "eventKind"> & {
  normalizedSchema?: string | null;
};

const SUPPORTED_NORMALIZED_SCHEMAS = new Set<string>([
  buildNormalizedRawEventSchema("contact", "observed"),
  buildNormalizedRawEventSchema("conversation", "observed"),
  buildNormalizedRawEventSchema("conversation", "removed"),
  buildNormalizedRawEventSchema("conversation", "linkedin_conversation_removed"),
  buildNormalizedRawEventSchema("message", "created"),
  buildNormalizedRawEventSchema("message", "message_created"),
  buildNormalizedRawEventSchema("message", "message_updated"),
  buildNormalizedRawEventSchema("message", "message_read_receipt"),
  buildNormalizedRawEventSchema("reaction", "created"),
  buildNormalizedRawEventSchema("reaction", "reaction_added"),
  buildNormalizedRawEventSchema("timeline_event", "linkedin_group_read_receipt"),
  buildNormalizedRawEventSchema("timeline_event", "linkedin_system_message"),
]);

export function resolveNormalizedSchemaForStoredRawEvent(event: StoredRawEvent): string {
  const normalizedSchema =
    event.normalizedSchema?.trim() ||
    buildNormalizedRawEventSchema(event.entityKind, event.eventKind);

  if (!SUPPORTED_NORMALIZED_SCHEMAS.has(normalizedSchema)) {
    throw new Error(
      `Unsupported normalized raw event schema '${normalizedSchema}' for ${event.entityKind}:${event.eventKind}. Update the adapter/upcaster or run a targeted platform resync.`,
    );
  }

  return normalizedSchema;
}

export function upcastNormalizedRawEventPayload(
  _normalizedSchema: string,
  payload: RawEventPayload,
): RawEventPayload {
  return payload;
}
