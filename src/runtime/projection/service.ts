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

    const remaining: PendingMessageHookBatch[] = [];
    for (const batch of this.pending) {
      if (batch.startRowId >= range.startRowId && batch.endRowId <= range.endRowId) {
        for (const payload of batch.payloads) {
          await emit(payload);
        }
        continue;
      }
      remaining.push(batch);
    }
    this.pending.length = 0;
    this.pending.push(...remaining);
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
