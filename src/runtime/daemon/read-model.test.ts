import { describe, expect, it, vi } from "vitest";
import type { LocalAccess, StatusAggregates } from "../../db/db-worker-jobs.js";
import { GlobalCuedSkillMonitor } from "../../skills/install.js";
import { DaemonReadModel, type ReadModelTopic } from "./read-model.js";

function aggregates(messages: number): StatusAggregates {
  return {
    overview: {
      contacts: 1,
      conversations: 1,
      messages,
      rawEvents: 1,
      sourceAccounts: 1,
      integrations: 1,
      authSessions: 0,
      messageBreakdown: [],
      integrationBreakdown: [],
    },
    phoneCalls: 0,
    searchIndex: { queued: 0, indexing: 0, failed: 0, pending: 0 },
  };
}

const LOCAL_ACCESS: LocalAccess = { permissions: [], localIntegrationStates: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createModel(run: (job: string) => Promise<unknown>, now: () => number = () => 0) {
  const db = { version: 1, statusContentVersion: () => db.version };
  const changes: ReadModelTopic[] = [];
  const errors: ReadModelTopic[] = [];
  const executor = { run: vi.fn(run) as never, close: async () => {} };
  const model = new DaemonReadModel(db, executor, {
    onChange: (topic) => changes.push(topic),
    onError: (topic) => errors.push(topic),
    now,
    skill: new GlobalCuedSkillMonitor(),
  });
  return { db, model, changes, errors, run: executor.run as ReturnType<typeof vi.fn> };
}

describe("daemon read model", () => {
  it("counts once and skips recounting while nothing countable was written", async () => {
    const { model, changes, run } = createModel(async () => aggregates(10));
    expect(model.aggregates).toBeNull();
    await model.refreshAggregates();
    await model.refreshAggregates();
    expect(run).toHaveBeenCalledTimes(1);
    expect(model.aggregates?.overview.messages).toBe(10);
    expect(changes).toEqual(["aggregates"]);
  });

  it("recounts after a write and announces only when the numbers moved", async () => {
    let messages = 10;
    const { db, model, changes, run } = createModel(async () => aggregates(messages));
    await model.refreshAggregates();
    db.version += 1;
    await model.refreshAggregates();
    expect(run).toHaveBeenCalledTimes(2);
    expect(changes).toEqual(["aggregates"]);

    messages = 11;
    db.version += 1;
    await model.refreshAggregates();
    expect(changes).toEqual(["aggregates", "aggregates"]);
  });

  it("collapses overlapping refreshes and counts again if a write landed meanwhile", async () => {
    const first = deferred<StatusAggregates>();
    const pending = [first.promise, Promise.resolve(aggregates(2))];
    const { db, model, run } = createModel(async () => pending.shift());
    const inFlight = model.refreshAggregates();
    void model.refreshAggregates();
    expect(run).toHaveBeenCalledTimes(1);

    db.version += 1;
    first.resolve(aggregates(1));
    await inFlight;
    await vi.waitFor(() => expect(model.aggregates?.overview.messages).toBe(2));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry by itself when the worker fails", async () => {
    const { db, model, errors, run } = createModel(async () => {
      throw new Error("worker gone");
    });
    await model.refreshAggregates();
    db.version += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["aggregates"]);
    // The next caller does try again.
    await model.refreshAggregates();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stays quiet once closed", async () => {
    const { model, errors, run } = createModel(async () => {
      throw new Error("worker closed");
    });
    model.close();
    await model.refreshAggregates();
    expect(run).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("reuses a fresh access probe and re-probes a stale one", async () => {
    let nowMs = 0;
    const { model, changes, run } = createModel(
      async () => LOCAL_ACCESS,
      () => nowMs,
    );
    await model.refreshLocalAccess();
    nowMs = 1_000;
    await model.refreshLocalAccess();
    expect(run).toHaveBeenCalledTimes(1);
    nowMs = 10_000;
    await model.refreshLocalAccess();
    expect(run).toHaveBeenCalledTimes(2);
    await model.refreshLocalAccess({ maxAgeMs: 0 });
    expect(run).toHaveBeenCalledTimes(3);
    // The value never changed, so subscribers were told once.
    expect(changes).toEqual(["local-access"]);
  });
});
