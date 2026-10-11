import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCuedDatabase } from "../db/database.js";
import { setTelemetryEnabled } from "./client.js";
import { DaemonTelemetryQueue } from "./queue.js";

let dir: string;
let db: ReturnType<typeof openCuedDatabase>;
let queue: DaemonTelemetryQueue;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CUED_TELEMETRY_ENDPOINT", "https://example.invalid/telemetry");
  dir = mkdtempSync(join(tmpdir(), "cued-telemetry-queue-"));
  db = openCuedDatabase(join(dir, "local.db"));
});

afterEach(async () => {
  const closing = queue?.close();
  await vi.advanceTimersByTimeAsync(500);
  await closing;
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function blackhole() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
}

describe("daemon telemetry queue", () => {
  it("does not wait for a blackholed endpoint and bounds backlog and concurrency", async () => {
    const fetchImpl = blackhole();
    queue = new DaemonTelemetryQueue(db, { fetchImpl });
    for (let i = 0; i < 1000; i++) queue.enqueue("sync_started");
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    queue.enqueue("sync_completed"); // In-flight event also counts against capacity.
    // Requests time out independently, without retrying failed envelopes.
    await vi.advanceTimersByTimeAsync(128 * 2000);
    expect(fetchImpl).toHaveBeenCalledTimes(128);
  });

  it("flushes pending sanitized events at shutdown without changing the endpoint contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    queue = new DaemonTelemetryQueue(db, { fetchImpl });
    const properties = { platform: "slack", message_text: "private", token: "secret" };
    queue.enqueue("sync_started", properties);
    properties.platform = "discord";
    queue.enqueue("sync_completed");
    await queue.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.event_name).toBe("sync_started");
    expect(body.properties).toEqual({ platform: "slack" });
    expect(Array.isArray(body)).toBe(false);
    queue.enqueue("sync_started");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds shutdown to 500ms and aborts the in-flight request", async () => {
    const fetchImpl = blackhole();
    queue = new DaemonTelemetryQueue(db, { fetchImpl });
    queue.enqueue("sync_started");
    queue.enqueue("sync_completed");
    const closing = queue.close();
    expect(queue.close()).toBe(closing);
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors opt-out before queued delivery", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    queue = new DaemonTelemetryQueue(db, { fetchImpl });
    queue.enqueue("sync_started");
    setTelemetryEnabled(db, false);
    await queue.close();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not drop a neighboring event when one delivery fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response(null, { status: 200 }));
    queue = new DaemonTelemetryQueue(db, { fetchImpl });
    queue.enqueue("sync_started");
    queue.enqueue("sync_completed");
    await queue.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).event_name).toBe(
      "sync_completed",
    );
  });
});
