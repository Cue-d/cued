import type { CuedDatabase } from "../db/database.js";
import { buildTelemetryEnvelope, isTelemetryEnabled, sendTelemetryEnvelope } from "./client.js";
import type { TelemetryEnvelope, TelemetryEventName, TelemetryProperties } from "./events.js";

const MAX_PENDING_EVENTS = 128;
const DRAIN_DELAY_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 500;

/** Daemon-only best-effort delivery. Short-lived CLI commands retain awaited sends. */
export class DaemonTelemetryQueue {
  private readonly pending: TelemetryEnvelope[] = [];
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly db: CuedDatabase,
    private readonly options: { fetchImpl?: typeof fetch } = {},
  ) {}

  enqueue(event: TelemetryEventName, properties: TelemetryProperties = {}): void {
    try {
      if (
        this.closed ||
        this.pending.length + Number(this.draining !== null) >= MAX_PENDING_EVENTS ||
        !isTelemetryEnabled(this.db)
      ) {
        return;
      }
      // Only sanitized envelopes are retained; no caller objects, database handles per event,
      // durable spool, or retry backlog. Overload drops newest events.
      this.pending.push(buildTelemetryEnvelope(this.db, event, properties));
      this.scheduleDrain();
    } catch {
      // Diagnostics must not interrupt ingestion, including during DB contention.
    }
  }

  private scheduleDrain(): void {
    if (this.closed || this.timer || this.draining || this.pending.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, DRAIN_DELAY_MS);
    this.timer.unref();
  }

  close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(deadline);
    this.pending.length = 0;
    this.abort.abort();
  }

  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.deliver().finally(() => {
        this.draining = null;
        this.scheduleDrain();
      });
    }
    return this.draining;
  }

  private async deliver(): Promise<void> {
    while (this.pending.length > 0 && !this.abort.signal.aborted) {
      const envelope = this.pending.shift()!;
      try {
        // Honor opt-out changes made while events were queued.
        if (!isTelemetryEnabled(this.db)) {
          this.pending.length = 0;
          return;
        }
        // Keep the existing single-envelope endpoint contract. One request in flight,
        // no retries; scheduling is coalesced without inventing a batch API.
        await sendTelemetryEnvelope(envelope, {
          ...this.options,
          signal: this.abort.signal,
        });
      } catch {
        // Drop failed events. A diagnostic endpoint outage must not create retry work.
      }
    }
  }
}
