import type { ProviderRawEventInput, RawEventAcquisitionMode } from "../../core/types/provider.js";
import type { CuedDatabase } from "../../db/database.js";
import { INGEST_INSERT_SLICE_BUDGET_MS, INGEST_INSERT_SLICE_EVENTS } from "./settings.js";

type RawEventInsertResult = ReturnType<CuedDatabase["insertRawEvents"]>;

const EMPTY_RAW_EVENT_INSERT_RESULT: RawEventInsertResult = {
  insertedCount: 0,
  insertedEvents: [],
  insertedRows: [],
  firstInsertedRowId: null,
  lastInsertedRowId: null,
};

function mergeRawEventInsertResults(
  left: RawEventInsertResult,
  right: RawEventInsertResult,
): RawEventInsertResult {
  const rowIds = [
    left.firstInsertedRowId,
    left.lastInsertedRowId,
    right.firstInsertedRowId,
    right.lastInsertedRowId,
  ].filter((rowId): rowId is number => rowId != null);
  return {
    insertedCount: left.insertedCount + right.insertedCount,
    insertedEvents: [...left.insertedEvents, ...right.insertedEvents],
    insertedRows: [...left.insertedRows, ...right.insertedRows],
    firstInsertedRowId: rowIds.length > 0 ? Math.min(...rowIds) : null,
    lastInsertedRowId: rowIds.length > 0 ? Math.max(...rowIds) : null,
  };
}

/**
 * Inserts a sync bundle's raw events a few milliseconds at a time, yielding in between.
 *
 * A bundle can be thousands of events, and inserting it in one synchronous transaction stalls
 * every request for the duration. Inserts are idempotent (existing ids are skipped) and the
 * sync checkpoint only advances after the whole bundle is in, so a crash between slices just
 * means the next sync re-fetches and skips what already landed.
 */
export async function insertRawEventsYielding(
  db: Pick<CuedDatabase, "insertRawEvents">,
  events: ProviderRawEventInput[],
  hooks: {
    /** Checked after every yield: the world may have changed while other work ran. */
    assertStillWanted?: () => void;
    /**
     * Called in the same turn as each insert, before anything else can run. Whatever must be
     * in place before another reader sees those rows (message-hook registration, which has
     * to precede any projection of them) belongs here, not after the whole bundle.
     */
    onInserted?: (inserted: RawEventInsertResult) => void;
  } = {},
): Promise<RawEventInsertResult> {
  let result = EMPTY_RAW_EVENT_INSERT_RESULT;
  let offset = 0;
  while (offset < events.length) {
    const sliceStartedAt = performance.now();
    do {
      const slice = events.slice(offset, offset + INGEST_INSERT_SLICE_EVENTS);
      offset += slice.length;
      const inserted = db.insertRawEvents(slice);
      hooks.onInserted?.(inserted);
      result = mergeRawEventInsertResults(result, inserted);
    } while (
      offset < events.length &&
      performance.now() - sliceStartedAt < INGEST_INSERT_SLICE_BUDGET_MS
    );
    if (offset < events.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      hooks.assertStillWanted?.();
    }
  }
  return result;
}

function withRawEventAcquisitionMode(
  rawEvents: ProviderRawEventInput[],
  acquisitionMode: RawEventAcquisitionMode,
): ProviderRawEventInput[] {
  return rawEvents.map((rawEvent) => ({
    ...rawEvent,
    provenance: {
      ...(rawEvent.provenance ?? {}),
      acquisitionMode,
    },
  }));
}

function summarizeRawEventsBySchema(
  rawEvents: ProviderRawEventInput[],
): Record<string, number> | undefined {
  if (rawEvents.length === 0) {
    return undefined;
  }

  const entries = new Map<string, number>();
  for (const rawEvent of rawEvents) {
    const key =
      typeof rawEvent.normalizedSchema === "string" && rawEvent.normalizedSchema.length > 0
        ? rawEvent.normalizedSchema
        : `${rawEvent.entityKind}.${rawEvent.eventKind}`;
    entries.set(key, (entries.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...entries.entries()].sort((left, right) =>
      left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1,
    ),
  );
}

function isInboundMessageEvent(rawEvent: Record<string, unknown>): boolean {
  return (
    rawEvent.entityKind === "message" &&
    rawEvent.eventKind === "created" &&
    typeof rawEvent.payload === "object" &&
    rawEvent.payload !== null &&
    typeof (rawEvent.payload as Record<string, unknown>).senderSourceKey === "string" &&
    ((rawEvent.payload as Record<string, unknown>).senderSourceKey as string).length > 0
  );
}

export {
  EMPTY_RAW_EVENT_INSERT_RESULT,
  isInboundMessageEvent,
  mergeRawEventInsertResults,
  summarizeRawEventsBySchema,
  withRawEventAcquisitionMode,
  type RawEventInsertResult,
};
