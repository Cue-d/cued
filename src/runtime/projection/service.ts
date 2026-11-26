import { safeParseJson } from "../../db/codecs.js";

export type ProjectionRunDetails = {
  trigger: string;
  startRowId: number;
  endRowId: number;
  projectionWatermark?: number;
  maxRawEventRowid?: number;
};

type PendingMessageHookBatch = {
  startRowId: number;
  endRowId: number;
  payloads: Array<Record<string, unknown>>;
  /** First row of the batch not yet covered by a completed projection range. */
  nextUncoveredRowId?: number;
};

export type ProjectionMessageHookPayload = {
  rowId: number;
  payload: Record<string, unknown>;
};

export function parseProjectionRunDetails(detailsJson: string | null): ProjectionRunDetails | null {
  const parsed = safeParseJson<Partial<ProjectionRunDetails> | null>(
    detailsJson,
    "sync_runs.details_json",
    null,
  );
  if (!parsed || typeof parsed.startRowId !== "number" || typeof parsed.endRowId !== "number") {
    return null;
  }

  return {
    trigger: typeof parsed.trigger === "string" ? parsed.trigger : "unknown",
    startRowId: parsed.startRowId,
    endRowId: parsed.endRowId,
    projectionWatermark:
      typeof parsed.projectionWatermark === "number" ? parsed.projectionWatermark : undefined,
    maxRawEventRowid:
      typeof parsed.maxRawEventRowid === "number" ? parsed.maxRawEventRowid : undefined,
  };
}

function clampProjectionRunDetails(
  details: ProjectionRunDetails,
  projectionWatermark: number,
): ProjectionRunDetails | null {
  const minimumStartRowId = projectionWatermark + 1;
  const startRowId = Math.max(details.startRowId, minimumStartRowId);
  if (details.endRowId < startRowId) {
    return null;
  }

  return {
    ...details,
    startRowId,
    projectionWatermark,
  };
}

export function mergeProjectionRunDetails(input: {
  existing: ProjectionRunDetails | null;
  incoming: ProjectionRunDetails;
  projectionWatermark: number;
  maxRawEventRowid: number;
}): ProjectionRunDetails | null {
  const normalizedIncoming = clampProjectionRunDetails(input.incoming, input.projectionWatermark);
  const normalizedExisting =
    input.existing == null
      ? null
      : clampProjectionRunDetails(input.existing, input.projectionWatermark);

  if (!normalizedIncoming) {
    return normalizedExisting;
  }

  if (!normalizedExisting) {
    return {
      ...normalizedIncoming,
      maxRawEventRowid: Math.max(
        normalizedIncoming.maxRawEventRowid ?? normalizedIncoming.endRowId,
        input.maxRawEventRowid,
      ),
    };
  }

  return {
    ...normalizedExisting,
    trigger: normalizedIncoming.trigger,
    startRowId: Math.min(normalizedExisting.startRowId, normalizedIncoming.startRowId),
    endRowId: Math.max(normalizedExisting.endRowId, normalizedIncoming.endRowId),
    projectionWatermark: input.projectionWatermark,
    maxRawEventRowid: Math.max(
      normalizedExisting.maxRawEventRowid ?? normalizedExisting.endRowId,
      normalizedIncoming.maxRawEventRowid ?? normalizedIncoming.endRowId,
      input.maxRawEventRowid,
    ),
  };
}

export class ProjectionMessageHookBarrier {
  private readonly pending: PendingMessageHookBatch[] = [];

  enqueue(
    range: { startRowId: number; endRowId: number },
    payloads: Array<Record<string, unknown>>,
  ): void {
    if (payloads.length === 0 || range.endRowId < range.startRowId) {
      return;
    }

    this.pending.push({
      startRowId: range.startRowId,
      endRowId: range.endRowId,
      payloads,
    });
    this.pending.sort((left, right) => left.startRowId - right.startRowId);
  }

  async releaseCompletedRange(
    range: { startRowId: number; endRowId: number },
    emit: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (range.endRowId < range.startRowId || this.pending.length === 0) {
      return;
    }

    // Projection runs cover the log in order but do not stop on batch boundaries: a run ends
    // wherever its limit falls, and the next continues from there. Coverage therefore
    // accumulates across runs, and a batch is released once every one of its rows has been
    // covered, not only when a single run happens to span it.
    const released: PendingMessageHookBatch[] = [];
    const remaining: PendingMessageHookBatch[] = [];
    for (const batch of this.pending) {
      const nextUncoveredRowId = batch.nextUncoveredRowId ?? batch.startRowId;
      if (range.startRowId <= nextUncoveredRowId && range.endRowId >= nextUncoveredRowId) {
        batch.nextUncoveredRowId = range.endRowId + 1;
      }
      if ((batch.nextUncoveredRowId ?? batch.startRowId) > batch.endRowId) {
        released.push(batch);
      } else {
        remaining.push(batch);
      }
    }
    // Take the released batches out of the queue before the first hook runs. Emitting awaits,
    // and while it does another release or enqueue can arrive: it must neither see these
    // batches again nor have its own additions overwritten when this call finishes.
    this.pending.length = 0;
    this.pending.push(...remaining);
    for (const batch of released) {
      for (const payload of batch.payloads) {
        await emit(payload);
      }
    }
  }

  /** Drops queued payloads that match, such as those of a source whose rows were deleted. */
  discard(matches: (payload: Record<string, unknown>) => boolean): void {
    const kept = this.pending
      .map((batch) => ({
        ...batch,
        payloads: batch.payloads.filter((payload) => !matches(payload)),
      }))
      .filter((batch) => batch.payloads.length > 0);
    this.pending.length = 0;
    this.pending.push(...kept);
  }

  async releaseAll(emit: (payload: Record<string, unknown>) => Promise<void>): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }

    const batches = [...this.pending].sort((left, right) => left.startRowId - right.startRowId);
    this.pending.length = 0;
    for (const batch of batches) {
      for (const payload of batch.payloads) {
        await emit(payload);
      }
    }
  }

  clear(): void {
    this.pending.length = 0;
  }
}

export function buildProjectionMessageHookBatches(
  range: { startRowId: number; endRowId: number },
  payloads: ProjectionMessageHookPayload[],
  batchSize: number,
): Array<{
  startRowId: number;
  endRowId: number;
  payloads: Array<Record<string, unknown>>;
}> {
  if (payloads.length === 0 || range.endRowId < range.startRowId || batchSize <= 0) {
    return [];
  }

  const batches = new Map<number, PendingMessageHookBatch>();
  for (const entry of payloads) {
    if (entry.rowId < range.startRowId || entry.rowId > range.endRowId) {
      continue;
    }

    const offset = entry.rowId - range.startRowId;
    const batchStart = range.startRowId + Math.floor(offset / batchSize) * batchSize;
    const batchEnd = Math.min(batchStart + batchSize - 1, range.endRowId);
    const existing = batches.get(batchStart);
    if (existing) {
      existing.payloads.push(entry.payload);
      continue;
    }
    batches.set(batchStart, {
      startRowId: batchStart,
      endRowId: batchEnd,
      payloads: [entry.payload],
    });
  }

  return [...batches.values()].sort((left, right) => left.startRowId - right.startRowId);
}
