import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { rebuildProjectedState } from "./projection/projector.js";
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
    expect(recentRuns.map((run) => run.account_key)).toEqual(["T_ENABLED_TWO", "T_ENABLED_ONE"]);
    expect(recentRuns.map((run) => run.trigger)).toEqual(["cli", "existing"]);

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

  it("preserves the legacy platform-only queue when no explicit sync targets exist", () => {
    const db = createDb();
    const queue = new RunQueueService(db);

    const result = queue.queueSyncRun("slack");

    expect(result).toEqual({
      queued: true,
      runId: result.runIds[0] ?? null,
      runIds: expect.any(Array),
      targets: ["slack"],
    });
    expect(result.runIds).toHaveLength(1);

    const [run] = db.listRecentRuns(1);
    expect(run).toMatchObject({
      platform: "slack",
      account_key: null,
      trigger: "cli",
      run_type: "sync",
      status: "queued",
    });

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

  it("records a manual contact merge and rebuilds projected state immediately", () => {
    const db = createDb();
    db.insertRawEvent({
      id: "contact-primary",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:primary",
      payload: {
        sourceEntityKey: "contacts:primary",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "phone", value: "+1 (555) 123-4567", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "contact-secondary",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "linkedin:secondary",
      payload: {
        sourceEntityKey: "linkedin:secondary",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "linkedin", value: "urn:li:person:ava-chen", deterministic: true }],
      },
      sourceVersion: "linkedin-v1",
    });

    rebuildProjectedState(db);
    const contacts = db.orm().all<{ id: string }>(sql`
      SELECT id
      FROM contacts
      ORDER BY created_at ASC, id ASC
    `);
    const queue = new RunQueueService(db);
    const result = queue.mergeContacts({
      primaryContactId: contacts[0]!.id,
      secondaryContactId: contacts[1]!.id,
      reason: "manual test",
    });

    expect(result).toEqual({
      merged: true,
      decisionId: expect.any(String),
      primaryContactId: contacts[0]!.id,
      secondaryContactId: contacts[1]!.id,
      canonicalContactId: contacts[0]!.id,
      projection: expect.objectContaining({
        contacts: 1,
        projectionWatermark: 2,
      }),
    });
    expect(db.getOverview().contacts).toBe(1);

    db.close();
  });
});
