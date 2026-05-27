import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { RunQueueService } from "./run-queue.js";

describe("RunQueueService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-run-queue-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("queues enabled Slack accounts instead of the default placeholder account", () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T_ENABLED_ONE",
      displayName: "Slack One",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
    });
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T_ENABLED_TWO",
      displayName: "Slack Two",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
    });
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T_DISABLED",
      displayName: "Slack Disabled",
      authState: "authenticated",
      enabled: false,
      connectionKind: "browser-session",
      syncCapable: true,
    });

    db.queueSyncRun({
      platform: "slack",
      accountKey: "T_ENABLED_ONE",
      runType: "sync",
      trigger: "existing",
      details: null,
    });

    const queue = new RunQueueService(db);
    const result = queue.queueSyncRun("slack");

    expect(result).toEqual({
      queued: true,
      runId: result.runIds[0] ?? null,
      runIds: expect.any(Array),
      targets: ["slack:T_ENABLED_TWO"],
    });
    expect(result.runIds).toHaveLength(1);

    const recentRuns = db.listRecentRuns(4).filter((run) => run.platform === "slack");
    expect(
      recentRuns
        .map((run) => ({ accountKey: run.account_key, trigger: run.trigger }))
        .sort((left, right) => String(left.accountKey).localeCompare(String(right.accountKey))),
    ).toEqual([
      { accountKey: "T_ENABLED_ONE", trigger: "existing" },
      { accountKey: "T_ENABLED_TWO", trigger: "cli" },
    ]);

    db.close();
  });

  it("queues authenticated accounts even when helper-dependent sync capability is stale", () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "linkedin",
      accountKey: "default",
      displayName: "LinkedIn",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "chromium-auth",
      launchTarget: "https://www.linkedin.com/login",
    });

    const queue = new RunQueueService(db);
    const result = queue.queueSyncRun("linkedin");

    expect(result).toEqual({
      queued: true,
      runId: result.runIds[0] ?? null,
      runIds: expect.any(Array),
      targets: ["linkedin:default"],
    });
    expect(result.runIds).toHaveLength(1);

    const [run] = db.listRecentRuns(1);
    expect(run).toMatchObject({
      platform: "linkedin",
      account_key: "default",
      trigger: "cli",
      run_type: "sync",
      status: "queued",
    });

    db.close();
  });

  it("does not queue source syncs without an explicit target", () => {
    const db = createDb();
    const queue = new RunQueueService(db);

    const result = queue.queueSyncRun("slack");

    expect(result).toEqual({
      queued: false,
      runId: null,
      runIds: [],
      targets: [],
    });
    expect(db.listRecentRuns(1)).toHaveLength(0);

    db.close();
  });

  it("preserves account keys that contain colons when queueing per-account syncs", () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "workspace:team",
      displayName: "Slack Colon",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
    });

    const queue = new RunQueueService(db);
    const result = queue.queueSyncRun("slack");

    expect(result).toEqual({
      queued: true,
      runId: result.runIds[0] ?? null,
      runIds: expect.any(Array),
      targets: ["slack:workspace:team"],
    });
    expect(result.runIds).toHaveLength(1);

    const [run] = db.listRecentRuns(1);
    expect(run).toMatchObject({
      platform: "slack",
      account_key: "workspace:team",
      trigger: "cli",
      run_type: "sync",
      status: "queued",
    });

    db.close();
  });

  it("resets source state without queueing a projection rebuild on the hot path", () => {
    const db = createDb();
    db.upsertSourceAccounts([
      { platform: "imessage", accountKey: "local", displayName: "Messages" },
    ]);
    db.insertRawEvent({
      id: "imessage-reset-raw",
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "created",
      observedAt: Date.now(),
      dedupeKey: "imessage-reset-raw",
      payload: {
        sourceMessageKey: "imessage:m1",
        sourceConversationKey: "imessage:c1",
      },
    });

    const queue = new RunQueueService(db);
    const result = queue.resetSource("imessage");

    expect(result).toMatchObject({
      source: "imessage",
      rowsRemoved: 2,
      rebuildQueued: false,
    });
    expect(db.getOverview().rawEvents).toBe(0);
    expect(db.listRecentRuns(1)).toEqual([]);

    db.close();
  });
});
