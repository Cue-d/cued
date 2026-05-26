import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase, openExistingCuedDatabase } from "./database.js";

describe("CuedDatabase", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("counts observed phone calls with a targeted raw event query", () => {
    const db = createDb();

    db.insertRawEvent({
      id: randomUUID(),
      platform: "imessage",
      accountKey: "local",
      entityKind: "call",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "imessage:call:1",
      payload: {
        sourceCallKey: "call-1",
        sourceConversationKey: "conversation-1",
        provider: "facetime",
        direction: "incoming",
        medium: "audio",
        status: "missed",
        startedAt: 1,
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: randomUUID(),
      platform: "slack",
      accountKey: "workspace",
      entityKind: "message",
      eventKind: "created",
      observedAt: 2,
      dedupeKey: "slack:message:1",
      payload: {
        sourceMessageKey: "message-1",
        sourceConversationKey: "channel-1",
        sender: { sourceContactKey: "user-1", displayName: "Ava" },
        sentAt: 2,
        text: "Not a call",
      },
      sourceVersion: "slack-v1",
    });

    expect(db.countObservedPhoneCalls()).toBe(1);

    db.close();
  });

  function insertContact(
    db: CuedDatabase,
    input: {
      id: string;
      name: string;
      updatedAt?: number;
    },
  ): void {
    const sqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
    const timestamp = input.updatedAt ?? Date.now();
    sqlite
      .prepare(
        `
      INSERT INTO contacts (id, kind, name, photo_url, company, archived, created_at, updated_at)
      VALUES (?, 'person', ?, NULL, NULL, 0, ?, ?)
    `,
      )
      .run(input.id, input.name, timestamp, timestamp);
  }

  function executeContactMerge(
    db: CuedDatabase,
    input: { primaryContactId: string; secondaryContactId: string; reason?: string | null },
  ) {
    const action = db.createAction({
      actionType: "contact.merge",
      payload: {
        primaryContactId: input.primaryContactId,
        secondaryContactId: input.secondaryContactId,
        reason: input.reason ?? null,
      },
      requiresApproval: false,
    });
    return db.executeApprovedAction(action.id, "test").result as {
      decisionId: string;
      primaryContactId: string;
      secondaryContactId: string;
      canonicalContactId: string;
    };
  }

  function insertHandle(
    db: CuedDatabase,
    input: {
      id: string;
      contactId: string;
      type: string;
      value: string;
      normalizedValue: string;
      platform: string;
      accountKey: string;
      isDeterministic?: number;
    },
  ): void {
    const sqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
    const timestamp = Date.now();
    sqlite
      .prepare(
        `
      INSERT INTO contact_handles (
        id, contact_id, type, value, normalized_value, platform, account_key, is_deterministic, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.id,
        input.contactId,
        input.type,
        input.value,
        input.normalizedValue,
        input.platform,
        input.accountKey,
        input.isDeterministic ?? 1,
        timestamp,
        timestamp,
      );
  }

  function sqlite(db: CuedDatabase) {
    return (
      db as unknown as {
        sqlite: {
          exec: (sql: string) => void;
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
            get: (...params: unknown[]) => unknown;
            all: (...params: unknown[]) => unknown[];
          };
        };
      }
    ).sqlite;
  }

  it("creates the schema and exposes overview counts", () => {
    const db = createDb();
    expect(db.getOverview()).toEqual({
      contacts: 0,
      conversations: 0,
      messages: 0,
      rawEvents: 0,
      sourceAccounts: 0,
      integrations: 0,
      authSessions: 0,
      messageBreakdown: [],
    });
    expect(
      (sqlite(db).prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual([
      "id",
      "action_type",
      "action_version",
      "status",
      "approval_status",
      "execution_status",
      "priority",
      "title",
      "summary",
      "payload_json",
      "payload_hash",
      "result_json",
      "error_json",
      "source_skill",
      "created_by",
      "approved_by",
      "denied_by",
      "executed_by",
      "requires_approval",
      "queued_at",
      "approved_at",
      "denied_at",
      "locked_at",
      "started_at",
      "executed_at",
      "updated_at",
      "dedupe_key",
    ]);
    expect(
      (
        sqlite(db).prepare("PRAGMA table_info(action_effects)").all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).toEqual([
      "id",
      "action_id",
      "effect_type",
      "target_table",
      "target_id",
      "payload_json",
      "applied_at",
      "reverted_at",
    ]);
    db.close();
  });

  it("drops stale action substrate columns without deleting legacy merge aliases", () => {
    const db = createDb();
    sqlite(db).exec(`
      ALTER TABLE actions ADD COLUMN source_job_id TEXT;
      INSERT INTO contact_merge_decisions (
        id,
        decision_type,
        primary_contact_id,
        secondary_contact_id,
        canonical_contact_id,
        reason,
        created_by,
        created_at
      ) VALUES (
        'decision-1',
        'merge',
        'contact-a',
        'contact-b',
        'contact-a',
        'same phone',
        'cli',
        1234
      );
    `);

    db.initializeSchema();

    expect(
      (sqlite(db).prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).not.toContain("source_job_id");
    expect(db.listContactMergeAliases()).toEqual([
      { contact_id: "contact-b", canonical_contact_id: "contact-a" },
    ]);
    db.close();
  });

  it("claims jobs by priority and reclaims expired leases", () => {
    const db = createDb();

    const lowPriorityJobId = db.queueJob({
      kind: "ingest",
      platform: "slack",
      accountKey: "T1",
      priority: 30,
      trigger: "test_low",
      checkpoint: { cursor: "a" },
    });
    const highPriorityJobId = db.queueJob({
      kind: "auth",
      platform: "slack",
      accountKey: "T1",
      priority: 0,
      trigger: "test_high",
    });

    const claimedHigh = db.claimNextJob({
      ownerId: "worker-a",
      leaseMs: 10_000,
    });
    expect(claimedHigh).toMatchObject({
      id: highPriorityJobId,
      kind: "auth",
      status: "running",
      owner_id: "worker-a",
      attempt: 1,
    });

    db.updateJobProgress(highPriorityJobId, {
      checkpoint: { openedBrowser: true },
      progress: { state: "waiting_for_callback" },
      leaseMs: 20_000,
    });
    db.failJob(highPriorityJobId, {
      error: new Error("network offline"),
      retryAt: Date.now() + 60_000,
    });

    const claimedLow = db.claimNextJob({
      ownerId: "worker-b",
      leaseMs: 10_000,
    });
    expect(claimedLow).toMatchObject({
      id: lowPriorityJobId,
      kind: "ingest",
      status: "running",
      owner_id: "worker-b",
      attempt: 1,
    });

    sqlite(db).prepare("UPDATE jobs SET lease_expires_at = 1 WHERE id = ?").run(lowPriorityJobId);
    const reclaimedLow = db.claimNextJob({
      ownerId: "worker-c",
      leaseMs: 10_000,
    });
    expect(reclaimedLow).toMatchObject({
      id: lowPriorityJobId,
      owner_id: "worker-c",
      attempt: 2,
    });

    db.completeJob(lowPriorityJobId, { done: true });
    expect(
      sqlite(db)
        .prepare("SELECT status, owner_id, lease_expires_at FROM jobs WHERE id = ?")
        .get(lowPriorityJobId),
    ).toEqual({ status: "completed", owner_id: null, lease_expires_at: null });

    db.close();
  });

  it("records the full action lifecycle and execution effects", () => {
    const db = createDb();

    const action = db.createAction({
      actionType: "contact.merge",
      actionVersion: "1",
      payload: {
        primaryContactId: "contact-a",
        secondaryContactId: "contact-b",
        evidence: ["same normalized phone"],
      },
      priority: 10,
      title: "Merge Ava duplicate",
      summary: "Exact handle overlap.",
      sourceSkill: "cued",
      createdBy: "agent",
      dedupeKey: "contact.merge:contact-a:contact-b",
    });

    expect(action).toMatchObject({
      action_type: "contact.merge",
      action_version: "1",
      status: "proposed",
      approval_status: "pending",
      execution_status: "pending",
      priority: 10,
      source_skill: "cued",
      created_by: "agent",
      requires_approval: 1,
      payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      dedupe_key: "contact.merge:contact-a:contact-b",
    });
    expect(JSON.parse(action.payload_json)).toEqual({
      primaryContactId: "contact-a",
      secondaryContactId: "contact-b",
      evidence: ["same normalized phone"],
    });

    const approved = db.approveAction(action.id, "soham");
    expect(approved).toMatchObject({
      status: "approved",
      approval_status: "approved",
      approved_by: "soham",
      approved_at: expect.any(Number),
    });

    const locked = db.lockActionForExecution(action.id, "daemon");
    expect(locked).toMatchObject({
      status: "executing",
      execution_status: "running",
      executed_by: "daemon",
      locked_at: expect.any(Number),
      started_at: expect.any(Number),
    });
    expect(() =>
      db.updateActionPayload(action.id, {
        primaryContactId: "contact-c",
        secondaryContactId: "contact-b",
      }),
    ).toThrow("Cannot update an action payload after execution has started.");

    const effect = db.recordActionEffect({
      actionId: action.id,
      effectType: "contact.merge.recorded",
      targetTable: "contacts",
      targetId: "contact-a",
      payload: { secondaryContactId: "contact-b", canonicalContactId: "contact-a" },
      appliedAt: 1234,
    });
    expect(effect).toMatchObject({
      action_id: action.id,
      effect_type: "contact.merge.recorded",
      target_table: "contacts",
      target_id: "contact-a",
      payload_json: JSON.stringify({
        secondaryContactId: "contact-b",
        canonicalContactId: "contact-a",
      }),
      applied_at: 1234,
      reverted_at: null,
    });

    const completed = db.completeAction(action.id, {
      merge: { secondaryContactId: "contact-b", canonicalContactId: "contact-a" },
    });
    expect(completed).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
      result_json: JSON.stringify({
        merge: { secondaryContactId: "contact-b", canonicalContactId: "contact-a" },
      }),
      executed_at: expect.any(Number),
    });
    expect(db.listActionEffects(action.id).map((row) => row.id)).toEqual([effect.id]);

    db.close();
  });

  it("enforces action approval and failure transitions", () => {
    const db = createDb();

    const pending = db.createAction({
      actionType: "contact.memory.add",
      payload: { contactId: "contact-a", body: "Works on applied AI." },
      createdBy: "agent",
    });
    expect(() => db.lockActionForExecution(pending.id)).toThrow(
      "Action must be approved before execution.",
    );

    const updated = db.updateActionPayload(pending.id, {
      contactId: "contact-a",
      body: "Works on applied AI and founder tooling.",
    });
    expect(JSON.parse(updated.payload_json)).toEqual({
      contactId: "contact-a",
      body: "Works on applied AI and founder tooling.",
    });
    expect(updated.payload_hash).not.toBe(pending.payload_hash);

    const denied = db.denyAction(pending.id, "soham");
    expect(denied).toMatchObject({
      status: "denied",
      approval_status: "denied",
      approved_by: null,
      denied_by: "soham",
      denied_at: expect.any(Number),
    });
    expect(() => db.approveAction(pending.id)).toThrow("Cannot approve a denied action.");

    const autoApproved = db.createAction({
      actionType: "contact.memory.stale",
      payload: { memoryId: "memory-1" },
      requiresApproval: false,
      createdBy: "system",
    });
    expect(autoApproved).toMatchObject({
      status: "approved",
      approval_status: "auto_approved",
      approved_by: "system",
      approved_at: expect.any(Number),
    });
    db.lockActionForExecution(autoApproved.id, "daemon");
    const failed = db.failAction(autoApproved.id, new Error("memory missing"));
    expect(failed).toMatchObject({
      status: "failed",
      execution_status: "failed",
      error_json: expect.stringContaining("memory missing"),
      executed_at: expect.any(Number),
    });

    db.close();
  });

  it("executes approved contact merge actions and records effects", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });
    insertContact(db, { id: "contact-b", name: "Ava Duplicate" });

    const action = db.createAction({
      actionType: "contact.merge",
      payload: {
        primaryContactId: "contact-a",
        secondaryContactId: "contact-b",
        reason: "same normalized phone",
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
      executed_by: "action-runner",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      action_id: action.id,
      effect_type: "contact.merge.recorded",
      target_table: "contacts",
      target_id: "contact-a",
    });
    expect(db.listActionEffects(action.id)).toEqual([
      expect.objectContaining({ action_id: action.id, target_id: "contact-a" }),
    ]);

    db.close();
  });

  it("validates action payloads again at execution time", () => {
    const db = createDb();
    const action = db.createAction({
      actionType: "contact.memory.add",
      payload: { contactId: "contact-a" },
      requiresApproval: false,
    });

    expect(() => db.executeApprovedAction(action.id, "action-runner")).toThrow(
      "Action payload failed validation: Missing required payload field 'body'.",
    );
    expect(db.getAction(action.id)).toMatchObject({
      status: "failed",
      execution_status: "failed",
      error_json: expect.stringContaining("Missing required payload field 'body'."),
    });

    db.close();
  });

  it("executes approved contact memory actions and records effects", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });

    const addAction = db.createAction({
      actionType: "contact.memory.add",
      payload: {
        contactId: "contact-a",
        body: "Works on applied AI.",
        sourceKind: "local_messages",
        evidence: { messageIds: ["message-1"] },
        confidence: 90,
      },
      requiresApproval: false,
    });
    const added = db.executeApprovedAction(addAction.id, "action-runner");
    expect(added.action).toMatchObject({ status: "executed", execution_status: "succeeded" });
    expect(added.effects[0]).toMatchObject({
      effect_type: "contact_memory.added",
      target_table: "contact_memories",
    });
    const memoryId = added.effects[0]!.target_id!;
    expect(db.getContactMemory(memoryId)).toMatchObject({
      contact_id: "contact-a",
      body: "Works on applied AI.",
      source_kind: "local_messages",
      confidence: 90,
      created_by: "action-runner",
    });

    const staleAction = db.createAction({
      actionType: "contact.memory.stale",
      payload: { memoryId },
      requiresApproval: false,
    });
    const staled = db.executeApprovedAction(staleAction.id, "action-runner");
    expect(staled.effects[0]).toMatchObject({
      effect_type: "contact_memory.marked_stale",
      target_table: "contact_memories",
      target_id: memoryId,
    });
    expect(db.getContactMemory(memoryId)).toMatchObject({
      id: memoryId,
      stale_at: expect.any(Number),
    });

    db.close();
  });

  it("executes approved follow-up recommendation actions without mutating contact state", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });

    const action = db.createAction({
      actionType: "contact.followup.recommend",
      payload: {
        contactId: "contact-a",
        reason: "They replied last week and no follow-up has been sent.",
        suggestedMessage: "Following up on our last thread.",
        dueAt: 1_735_689_600_000,
        evidence: { messageIds: ["message-1"] },
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "contact.followup.recommended",
      target_table: "contacts",
      target_id: "contact-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      contactId: "contact-a",
      reason: "They replied last week and no follow-up has been sent.",
      suggestedMessage: "Following up on our last thread.",
      dueAt: 1_735_689_600_000,
      evidence: { messageIds: ["message-1"] },
    });

    db.close();
  });

  it("executes approved enrichment recommendation actions as effects only", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });

    const action = db.createAction({
      actionType: "contact.enrichment.recommend",
      payload: {
        contactId: "contact-a",
        field: "linkedin",
        value: "https://www.linkedin.com/in/ava-chen",
        sourceKind: "contact_sources",
        evidence: { sourceEntityKey: "linkedin:ava-chen" },
        confidence: 95,
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "contact.enrichment.recommended",
      target_table: "contacts",
      target_id: "contact-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      contactId: "contact-a",
      field: "linkedin",
      value: "https://www.linkedin.com/in/ava-chen",
      sourceKind: "contact_sources",
      evidence: { sourceEntityKey: "linkedin:ava-chen" },
      confidence: 95,
    });

    db.close();
  });

  it("executes approved introduction recommendation actions as effects only", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });
    insertContact(db, { id: "contact-b", name: "Ben Ross" });

    const action = db.createAction({
      actionType: "contact.introduction.recommend",
      payload: {
        fromContactId: "contact-a",
        toContactId: "contact-b",
        reason: "Both have discussed local-first agent infrastructure.",
        suggestedIntro: "You should meet because you are working on overlapping problems.",
        evidence: { sharedTopics: ["agents", "local context"] },
        confidence: 75,
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "contact.introduction.recommended",
      target_table: "contacts",
      target_id: "contact-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      fromContactId: "contact-a",
      toContactId: "contact-b",
      reason: "Both have discussed local-first agent infrastructure.",
      suggestedIntro: "You should meet because you are working on overlapping problems.",
      evidence: { sharedTopics: ["agents", "local context"] },
      confidence: 75,
    });

    db.close();
  });

  it("executes approved message draft actions as effects only", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Chen" });

    const action = db.createAction({
      actionType: "contact.message.draft",
      payload: {
        contactId: "contact-a",
        body: "Following up on our last thread.",
        reason: "Recent inbound message has no newer outbound reply.",
        channelHint: "imessage",
        evidence: { messageIds: ["message-1"] },
        confidence: 70,
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "contact.message.drafted",
      target_table: "contacts",
      target_id: "contact-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      contactId: "contact-a",
      body: "Following up on our last thread.",
      reason: "Recent inbound message has no newer outbound reply.",
      channelHint: "imessage",
      evidence: { messageIds: ["message-1"] },
      confidence: 70,
    });

    db.close();
  });

  it("executes approved conversation summary draft actions as effects only", () => {
    const db = createDb();
    insertConversation(db, "conversation-a", "Ava / Ben");

    const action = db.createAction({
      actionType: "conversation.summary.draft",
      payload: {
        conversationId: "conversation-a",
        summary: "Discussed local-first agent context and action queues.",
        reason: "Recent conversation summary requested by agent smoke.",
        timeWindow: "last_30_days",
        evidence: { messageCount: 12 },
        confidence: 65,
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "conversation.summary.drafted",
      target_table: "conversations",
      target_id: "conversation-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      conversationId: "conversation-a",
      summary: "Discussed local-first agent context and action queues.",
      reason: "Recent conversation summary requested by agent smoke.",
      timeWindow: "last_30_days",
      evidence: { messageCount: 12 },
      confidence: 65,
    });

    db.close();
  });

  it("executes approved conversation follow-up recommendation actions as effects only", () => {
    const db = createDb();
    insertConversation(db, "conversation-a", "Ava / Ben");

    const action = db.createAction({
      actionType: "conversation.followup.recommend",
      payload: {
        conversationId: "conversation-a",
        reason: "The thread has recent activity and needs a next step.",
        suggestedNextStep: "Review the thread and decide whether to reply.",
        evidence: { messageCount: 12 },
        confidence: 60,
      },
      requiresApproval: false,
    });

    const executed = db.executeApprovedAction(action.id, "action-runner");
    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
    });
    expect(executed.effects).toHaveLength(1);
    expect(executed.effects[0]).toMatchObject({
      effect_type: "conversation.followup.recommended",
      target_table: "conversations",
      target_id: "conversation-a",
    });
    expect(JSON.parse(executed.effects[0]!.payload_json!)).toEqual({
      conversationId: "conversation-a",
      reason: "The thread has recent activity and needs a next step.",
      suggestedNextStep: "Review the thread and decide whether to reply.",
      evidence: { messageCount: 12 },
      confidence: 60,
    });

    db.close();
  });

  it("lists approved pending actions in execution order", () => {
    const db = createDb();
    const proposed = db.createAction({
      actionType: "contact.memory.stale",
      payload: { memoryId: "memory-proposed" },
    });
    const lowPriority = db.createAction({
      actionType: "contact.memory.stale",
      payload: { memoryId: "memory-low" },
      priority: 10,
      requiresApproval: false,
    });
    const highPriority = db.createAction({
      actionType: "contact.memory.stale",
      payload: { memoryId: "memory-high" },
      priority: -1,
      requiresApproval: false,
    });
    db.approveAction(proposed.id, "soham");
    db.lockActionForExecution(lowPriority.id, "runner");

    expect(db.listApprovedPendingActions().map((action) => action.id)).toEqual([
      highPriority.id,
      proposed.id,
    ]);

    db.close();
  });

  it("queues and claims message FTS indexing work independently", () => {
    const db = createDb();

    expect(db.enqueueMessageFtsIndex(["message-a", "message-b", "message-a"], "projection")).toBe(
      2,
    );
    expect(db.enqueueMessageFtsIndex(["message-a"], "conversation_renamed")).toBe(1);

    const claimed = db.claimMessageFtsIndexBatch(10);
    expect(claimed.map((row) => row.message_id).sort()).toEqual(["message-a", "message-b"]);
    expect(claimed.every((row) => row.status === "indexing" && row.attempt === 1)).toBe(true);
    expect(db.getMessageFtsIndexBacklog()).toEqual({
      queued: 0,
      indexing: 2,
      failed: 0,
      pending: 2,
    });

    expect(db.completeMessageFtsIndex(["message-a"])).toBe(1);
    expect(db.failMessageFtsIndex(["message-b"], new Error("fts busy"))).toBe(1);
    expect(db.getMessageFtsIndexBacklog()).toEqual({
      queued: 0,
      indexing: 0,
      failed: 1,
      pending: 0,
    });
    expect(
      sqlite(db)
        .prepare("SELECT message_id, status, last_error FROM message_fts_index_queue")
        .all(),
    ).toEqual([{ message_id: "message-b", status: "failed", last_error: "fts busy" }]);

    db.close();
  });

  it("drains queued message FTS indexing work in bounded batches", () => {
    const db = createDb();
    const timestamp = Date.now();
    sqlite(db)
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type,
          is_active, removal_reason, service, name, topic, participant_names, last_message_id,
          last_message_at, last_message_preview, unread_count, created_at, updated_at
        ) VALUES (
          'conversation-a', 'slack', 'team-a', 'channel-a', NULL, 'group',
          1, NULL, NULL, 'Launch', NULL, 'Theo | Soham', NULL,
          NULL, NULL, 0, ?, ?
        )
      `,
      )
      .run(timestamp, timestamp);
    sqlite(db)
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id,
          sender_contact_id, sender_source_key, sender_name, conversation_name, sent_at,
          service, status, is_from_me, content, delivered_at, read_at, edited_at,
          deleted_at, reply_to_message_id, is_deleted, is_edited, attachment_count,
          reaction_count, created_at, updated_at
        ) VALUES (
          'message-a', 'slack', 'team-a', 'ts-a', 'conversation-a',
          NULL, NULL, 'Soham', 'Launch', ?, NULL, NULL, 0,
          'queued index content', NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?, ?
        )
      `,
      )
      .run(timestamp, timestamp, timestamp);
    sqlite(db).prepare("DELETE FROM messages_fts").run();

    expect(db.enqueueMessageFtsIndex(["message-a"], "projection")).toBe(1);
    expect(db.drainMessageFtsIndexQueue(1)).toEqual({ claimed: 1, indexed: 1, failed: 0 });
    expect(
      sqlite(db)
        .prepare("SELECT message_id, content FROM messages_fts WHERE messages_fts MATCH ?")
        .all("queued"),
    ).toEqual([{ message_id: "message-a", content: "queued index content" }]);
    expect(
      sqlite(db).prepare("SELECT COUNT(*) AS count FROM message_fts_index_queue").get(),
    ).toEqual({ count: 0 });

    db.close();
  });

  it("requeues stale message FTS indexing work", () => {
    const db = createDb();
    const timestamp = Date.now();

    expect(db.enqueueMessageFtsIndex(["message-a", "message-b"], "projection")).toBe(2);
    expect(db.claimMessageFtsIndexBatch(2)).toHaveLength(2);
    sqlite(db)
      .prepare("UPDATE message_fts_index_queue SET updated_at = ? WHERE message_id = 'message-a'")
      .run(timestamp - 10_000);

    expect(db.requeueStaleMessageFtsIndexing(timestamp - 5_000)).toBe(1);
    expect(
      sqlite(db)
        .prepare("SELECT message_id, status FROM message_fts_index_queue ORDER BY message_id")
        .all(),
    ).toEqual([
      { message_id: "message-a", status: "queued" },
      { message_id: "message-b", status: "indexing" },
    ]);

    db.close();
  });

  it("executes read-only SQL for ad hoc inspection", () => {
    const db = createDb();

    expect(db.executeReadOnlySql("select 1 as value")).toEqual([{ value: 1 }]);
    expect(() => db.executeReadOnlySql("insert into app_settings (key) values ('nope')")).toThrow(
      "Only read-only SELECT/PRAGMA/EXPLAIN queries are supported",
    );

    db.close();
  });

  it("stores daemon state", () => {
    const db = createDb();

    db.upsertDaemonState({
      pid: 42,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      status: "running",
      version: "0.1.0",
      details: { source: "test" },
    });

    expect(db.getDaemonState()).toEqual({
      singleton_key: "daemon",
      pid: 42,
      started_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_500,
      status: "running",
      version: "0.1.0",
      details_json: JSON.stringify({ source: "test" }),
    });

    db.close();
  });

  it("stores current contact memories and marks superseded memories stale", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen" });

    const original = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      evidence: { messageIds: ["message-1"] },
      confidence: 83,
      createdBy: "test",
    });

    expect(original).toMatchObject({
      contact_id: "contact-1",
      contact_name: "Ava Chen",
      body: "Works on applied AI and prefers concise follow-ups.",
      source_kind: "local_messages",
      evidence_json: JSON.stringify({ messageIds: ["message-1"] }),
      confidence: 83,
      stale_at: null,
      created_by: "test",
    });

    const replacement = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers direct, concise messages.",
      sourceKind: "local_messages",
      evidence: { messageIds: ["message-2"], supersedesReason: "more recent evidence" },
      confidence: 91,
      supersedesMemoryId: original.id,
      createdBy: "test",
    });

    expect(replacement.supersedes_memory_id).toBe(original.id);
    expect(db.getContactMemory(original.id)?.stale_at).toEqual(expect.any(Number));
    expect(db.listContactMemories({ contactId: "contact-1" }).map((row) => row.id)).toEqual([
      replacement.id,
    ]);
    expect(
      db.listContactMemories({ contactId: "contact-1", includeStale: true }).map((row) => row.id),
    ).toEqual([replacement.id, original.id]);

    db.close();
  });

  it("rejects superseding a memory from a different contact", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen" });
    insertContact(db, { id: "contact-2", name: "Ben Lee" });
    const otherMemory = db.addContactMemory({
      contactId: "contact-2",
      body: "Works on robotics.",
      sourceKind: "local_messages",
    });

    expect(() =>
      db.addContactMemory({
        contactId: "contact-1",
        body: "Works on applied AI.",
        sourceKind: "local_messages",
        supersedesMemoryId: otherMemory.id,
      }),
    ).toThrow("Cannot supersede a contact memory from a different contact.");

    db.close();
  });

  it("preserves contact memories across projected state rebuilds", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 1 });
    const memory = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    db.clearProjectedState();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 2 });

    expect(db.getContactMemory(memory.id)).toMatchObject({
      id: memory.id,
      contact_id: "contact-1",
      contact_name: "Ava Chen",
      body: "Works on applied AI and prefers concise follow-ups.",
    });

    db.close();
  });

  it("can read and stale preserved contact memories when the projected contact is absent", () => {
    const db = createDb();
    insertContact(db, { id: "contact-1", name: "Ava Chen", updatedAt: 1 });
    const memory = db.addContactMemory({
      contactId: "contact-1",
      body: "Works on applied AI and prefers concise follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    db.clearProjectedState();

    expect(db.getContactMemory(memory.id)).toMatchObject({
      id: memory.id,
      contact_id: "contact-1",
      contact_name: null,
      body: "Works on applied AI and prefers concise follow-ups.",
      stale_at: null,
    });
    expect(db.listContactMemories({ contactId: "contact-1" }).map((row) => row.id)).toEqual([
      memory.id,
    ]);
    expect(db.markContactMemoryStale(memory.id)).toMatchObject({
      id: memory.id,
      contact_name: null,
      stale_at: expect.any(Number),
    });

    db.close();
  });

  it("persists generic sync scopes and proofs", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
          displayName: "eng",
          metadata: {
            teamId: "T123",
            conversationFamily: "channels",
          },
        },
        proofKind: "messages",
        status: "running",
        syncMode: "full",
        observedAt: 200,
        resumeCursor: {
          historyCursor: "history-2",
        },
        coverage: {
          oldestMessageTs: "1710000000.000100",
          newestMessageTs: "1710000000.000100",
        },
      },
    });

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
          displayName: "eng",
        },
        proofKind: "messages",
        status: "complete",
        syncMode: "full",
        observedAt: 300,
        coverage: {
          oldestMessageTs: "1709999999.000000",
          newestMessageTs: "1710000000.000300",
        },
        stats: {
          knownConversationCount: 3,
        },
      },
    });

    expect(db.listSyncScopes("slack", "workspace-a")).toEqual([
      expect.objectContaining({
        platform: "slack",
        account_key: "workspace-a",
        scope_kind: "conversation",
        scope_key: "C123",
        display_name: "eng",
        metadata_json: JSON.stringify({
          teamId: "T123",
          conversationFamily: "channels",
        }),
        first_discovered_at: 200,
        last_observed_at: 300,
      }),
    ]);

    expect(db.listSyncProofs("slack", "workspace-a")).toEqual([
      expect.objectContaining({
        platform: "slack",
        account_key: "workspace-a",
        scope_kind: "conversation",
        scope_key: "C123",
        proof_kind: "messages",
        status: "complete",
        sync_mode: "full",
        completed_at: 300,
        resume_cursor_json: null,
        coverage_json: JSON.stringify({
          oldestMessageTs: "1709999999.000000",
          newestMessageTs: "1710000000.000300",
        }),
        stats_json: JSON.stringify({
          knownConversationCount: 3,
        }),
      }),
    ]);

    db.close();
  });

  it("uses unambiguous generic sync proof ids for colon-bearing keys", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "a:b",
      proof: {
        scope: {
          kind: "conversation",
          key: "d",
        },
        proofKind: "messages",
        status: "running",
        observedAt: 100,
      },
    });
    db.upsertSyncProof({
      platform: "slack",
      accountKey: "a",
      proof: {
        scope: {
          kind: "conversation",
          key: "c:d",
        },
        proofKind: "messages",
        status: "complete",
        observedAt: 200,
      },
    });

    expect(db.listSyncScopes("slack", "a:b")).toEqual([
      expect.objectContaining({
        account_key: "a:b",
        scope_kind: "conversation",
        scope_key: "d",
      }),
    ]);
    expect(db.listSyncScopes("slack", "a")).toEqual([
      expect.objectContaining({
        account_key: "a",
        scope_kind: "conversation",
        scope_key: "c:d",
      }),
    ]);
    expect(db.listSyncProofs("slack", "a:b")).toEqual([
      expect.objectContaining({
        account_key: "a:b",
        scope_kind: "conversation",
        scope_key: "d",
        status: "running",
      }),
    ]);
    expect(db.listSyncProofs("slack", "a")).toEqual([
      expect.objectContaining({
        account_key: "a",
        scope_kind: "conversation",
        scope_key: "c:d",
        status: "complete",
      }),
    ]);

    db.close();
  });

  it("rejects sync proofs without a known proof contract", () => {
    const db = createDb();

    expect(() =>
      db.upsertSyncProof({
        platform: "slack",
        accountKey: "workspace-a",
        proof: {
          scope: {
            kind: "account",
            key: "workspace-a",
          },
          proofKind: "replies",
          status: "running",
          observedAt: 100,
        },
      }),
    ).toThrow("No sync proof contract for slack:account:replies");

    db.close();
  });

  it("clears completed_at when a generic sync proof returns to running", () => {
    const db = createDb();

    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "complete",
        observedAt: 100,
      },
    });
    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof: {
        scope: {
          kind: "conversation",
          key: "C123",
        },
        proofKind: "messages",
        status: "running",
        observedAt: 200,
      },
    });

    expect(db.listSyncProofs("slack", "workspace-a")).toEqual([
      expect.objectContaining({
        status: "running",
        completed_at: null,
      }),
    ]);

    db.close();
  });

  it("persists app settings and install metadata", () => {
    const db = createDb();

    db.recordAppMetadata({
      version: "0.1.0-internal.1",
      releaseChannel: "internal",
      cliSymlinkInstalled: true,
    });
    db.markOnboardingCompleted("0.1.0-internal.1");
    db.markReleaseCheck(123456789);

    expect(db.getAppMetadata()).toEqual({
      onboardingCompletedVersion: "0.1.0-internal.1",
      releaseChannel: "internal",
      installedAppVersion: "0.1.0-internal.1",
      lastReleaseCheckAt: 123456789,
      cliSymlinkInstalled: true,
      updateReleaseState: null,
      updatePendingRollback: null,
      updateLastError: null,
    });
    expect(db.getAppSetting("installed_app_version")?.value).toBe("0.1.0-internal.1");

    db.close();
  });

  it("opens existing databases without startup metadata writes", () => {
    const db = createDb();
    const dbPath = db.dbPath;
    db.recordAppMetadata({
      version: "0.1.0",
      releaseChannel: "stable",
    });
    db.close();

    const existing = openExistingCuedDatabase(dbPath);
    existing.setUpdateLastError(null);
    existing.close();

    const reopened = new CuedDatabase(dbPath);
    expect(reopened.getAppMetadata().installedAppVersion).toBe("0.1.0");
    expect(reopened.getAppMetadata().releaseChannel).toBe("stable");
    reopened.close();

    const missingDir = mkdtempSync(join(tmpdir(), "cued-v2-db-missing-"));
    tempDirs.push(missingDir);
    const missingPath = join(missingDir, "local.db");
    expect(() => openExistingCuedDatabase(missingPath)).toThrow(
      `Cued database does not exist at ${missingPath}`,
    );
    expect(existsSync(missingPath)).toBe(false);
  });

  it("reads projection backlog without initializing projection state", () => {
    const db = createDb();
    const dbPath = db.dbPath;
    db.close();

    const readonly = openExistingCuedDatabase(dbPath, { readonly: true });
    expect(readonly.getProjectionBacklog({ initializeProjectionState: false })).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 0,
      pending_raw_events: 0,
    });
    readonly.close();
  });

  it("manages integration states", () => {
    const db = createDb();

    db.upsertIntegrationState({
      platform: "linkedin",
      accountKey: "default",
      displayName: "LinkedIn",
      authState: "authorized",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      metadata: { source: "test" },
    });

    expect(db.listEnabledSyncPlatforms()).toEqual(["linkedin"]);
    expect(db.getIntegrationState("linkedin", "default")).toEqual(
      expect.objectContaining({
        platform: "linkedin",
        account_key: "default",
        auth_state: "authorized",
        enabled: 1,
        sync_capable: 1,
        metadata_json: JSON.stringify({ source: "test" }),
      }),
    );

    db.setIntegrationEnabled("linkedin", "default", false);
    expect(db.listIntegrationStates()).toEqual([
      expect.objectContaining({
        platform: "linkedin",
        account_key: "default",
        enabled: 0,
      }),
    ]);

    db.close();
  });

  it("repairs canonical integration ids when upserting existing platform accounts", () => {
    const db = createDb();
    const timestamp = Date.now();
    sqlite(db)
      .prepare(
        `
        INSERT INTO integration_states (
          id, platform, account_key, display_name, auth_state, enabled, connection_kind,
          sync_capable, launch_strategy, launch_target, imported_from, artifact_paths_json,
          metadata_json, last_seen_at, created_at, updated_at
        ) VALUES (?, 'signal', 'default', 'Signal', 'cancelled', 0, 'local-cli', 0,
          'qr-native', NULL, 'legacy', '[]', '{}', ?, ?, ?)
      `,
      )
      .run("legacy-signal-id", timestamp, timestamp, timestamp);

    const legacySessionId = db.createAuthSession({
      platform: "signal",
      accountKey: "default",
      integrationStateId: "legacy-signal-id",
      state: "cancelled",
    });

    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
      authState: "requested",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: false,
      launchStrategy: "qr-native",
      importedFrom: "bundled-helper",
    });

    expect(db.getIntegrationState("signal", "default")).toEqual(
      expect.objectContaining({
        id: "signal:default",
        auth_state: "requested",
        enabled: 1,
      }),
    );

    expect(db.getAuthSession(legacySessionId)).toEqual(
      expect.objectContaining({
        integration_state_id: "signal:default",
      }),
    );

    const sessionId = db.createAuthSession({
      platform: "signal",
      accountKey: "default",
      integrationStateId: "signal:default",
      state: "requested",
    });
    expect(db.getAuthSession(sessionId)).toEqual(
      expect.objectContaining({
        integration_state_id: "signal:default",
      }),
    );

    db.close();
  });

  it("tracks auth sessions independently from integration state", () => {
    const db = createDb();

    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "workspace-a",
      displayName: "Slack Workspace A",
      authState: "requested",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "native-auth",
      launchTarget: "https://slack.com/signin",
    });

    const sessionId = db.createAuthSession({
      platform: "slack",
      accountKey: "workspace-a",
      integrationStateId: "slack:workspace-a",
      state: "requested",
    });

    db.updateAuthSessionState({
      id: sessionId,
      state: "authenticated",
      nativePid: null,
      startedAt: 10,
      finishedAt: 20,
      keychainService: "so.cued.desktop.auth.slack",
      keychainAccount: "workspace-a",
      resultSummary: { teamId: "T123" },
    });

    expect(db.getOverview().authSessions).toBe(1);
    expect(db.getAuthSession(sessionId)).toEqual(
      expect.objectContaining({
        id: sessionId,
        state: "authenticated",
        keychain_service: "so.cued.desktop.auth.slack",
        keychain_account: "workspace-a",
        result_summary_json: JSON.stringify({ teamId: "T123" }),
      }),
    );
    expect(db.getLatestAuthSession("slack", "workspace-a")?.id).toBe(sessionId);

    db.close();
  });

  it("queues and retries outbound messages", () => {
    const db = createDb();

    const messageId = db.queueOutboundMessage({
      platform: "signal",
      accountKey: "default",
      target: "+14155550123",
      text: "Hello",
    });

    const claimed = db.claimNextOutboundMessage("signal");
    expect(claimed).toEqual(
      expect.objectContaining({
        id: messageId,
        platform: "signal",
        account_key: "default",
        status: "sending",
        attempt_count: 1,
      }),
    );

    db.failOutboundMessage({
      id: messageId,
      retryable: true,
      error: "network timeout",
      retryDelayMs: 0,
    });
    expect(db.hasQueuedOutboundMessages("signal")).toBe(true);

    const retried = db.claimNextOutboundMessage("signal");
    expect(retried?.attempt_count).toBe(2);
    db.completeOutboundMessage(messageId);
    expect(db.hasQueuedOutboundMessages("signal")).toBe(false);
    db.close();
  });

  it("resolves Signal targets by preferring signal_id over phone without merging contacts", () => {
    const db = createDb();

    insertContact(db, { id: "contact-phone", name: "Soham Bafana", updatedAt: 10 });
    insertContact(db, { id: "contact-signal", name: "Soham Bafana", updatedAt: 20 });

    insertHandle(db, {
      id: "handle-phone",
      contactId: "contact-phone",
      type: "phone",
      value: "+12016824050",
      normalizedValue: "2016824050",
      platform: "contacts",
      accountKey: "local",
    });
    insertHandle(db, {
      id: "handle-signal",
      contactId: "contact-signal",
      type: "signal_id",
      value: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      normalizedValue: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      platform: "signal",
      accountKey: "default",
    });

    expect(db.resolveSignalSendTarget("Soham Bafana")).toEqual({
      target: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadId: "dm:d6ed1597-758c-4022-96aa-253b334f1f5d",
      resolution: "signal_id",
      matchedContactIds: ["contact-signal", "contact-phone"],
      matchedName: "Soham Bafana",
    });

    expect(db.resolveSignalSendTarget("+12016824050")).toEqual({
      target: "d6ed1597-758c-4022-96aa-253b334f1f5d",
      threadId: "dm:d6ed1597-758c-4022-96aa-253b334f1f5d",
      resolution: "signal_id",
      matchedContactIds: ["contact-phone", "contact-signal"],
      matchedName: "Soham Bafana",
    });

    db.close();
  });

  it("keeps direct Signal phone sends as passthrough when there is no better contact match", () => {
    const db = createDb();

    expect(db.resolveSignalSendTarget("+14155550123")).toEqual({
      target: "+14155550123",
      threadId: "dm:+14155550123",
      resolution: "passthrough",
      matchedContactIds: [],
      matchedName: null,
    });

    db.close();
  });

  it("formats local Signal phone sends as E.164 passthrough", () => {
    const db = createDb();

    expect(db.resolveSignalSendTarget("4155550123")).toEqual({
      target: "+14155550123",
      threadId: "dm:+14155550123",
      resolution: "passthrough",
      matchedContactIds: [],
      matchedName: null,
    });

    db.close();
  });

  it("resolves WhatsApp targets by preferring whatsapp_jid over phone without merging contacts", () => {
    const db = createDb();

    insertContact(db, { id: "contact-phone", name: "Soham Bafana", updatedAt: 10 });
    insertContact(db, { id: "contact-whatsapp", name: "Soham Bafana", updatedAt: 20 });

    insertHandle(db, {
      id: "wa-handle-phone",
      contactId: "contact-phone",
      type: "phone",
      value: "+12016824050",
      normalizedValue: "2016824050",
      platform: "contacts",
      accountKey: "local",
    });
    insertHandle(db, {
      id: "wa-handle-jid",
      contactId: "contact-whatsapp",
      type: "whatsapp_jid",
      value: "12016824050@s.whatsapp.net",
      normalizedValue: "12016824050@s.whatsapp.net",
      platform: "whatsapp",
      accountKey: "default",
    });

    expect(db.resolveWhatsAppSendTarget("Soham Bafana")).toEqual({
      target: "12016824050@s.whatsapp.net",
      threadId: "dm:12016824050@s.whatsapp.net",
      resolution: "whatsapp_jid",
      matchedContactIds: ["contact-whatsapp", "contact-phone"],
      matchedName: "Soham Bafana",
    });

    expect(db.resolveWhatsAppSendTarget("+12016824050")).toEqual({
      target: "12016824050@s.whatsapp.net",
      threadId: "dm:12016824050@s.whatsapp.net",
      resolution: "whatsapp_jid",
      matchedContactIds: ["contact-phone", "contact-whatsapp"],
      matchedName: "Soham Bafana",
    });

    db.close();
  });

  it("formats local WhatsApp phone sends as JIDs", () => {
    const db = createDb();

    expect(db.resolveWhatsAppSendTarget("4155550123")).toEqual({
      target: "14155550123@s.whatsapp.net",
      threadId: "dm:14155550123@s.whatsapp.net",
      resolution: "passthrough",
      matchedContactIds: [],
      matchedName: null,
    });

    db.close();
  });

  it("resolves Discord send targets only for DMs and group DMs", () => {
    const db = createDb();
    const sql = sqlite(db);
    const timestamp = Date.now();

    sql
      .prepare(
        `
      INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          removal_reason, name, topic, participant_names, last_message_id, last_message_at,
          last_message_preview, unread_count, created_at, updated_at
        ) VALUES (?, 'discord', 'default', ?, ?, ?, 1, NULL, ?, NULL, '[]', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("discord-dm", "discord:channel:dm-1", "dm-1", "dm", "Jarvis", timestamp, timestamp);
    sql
      .prepare(
        `
      INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          removal_reason, name, topic, participant_names, last_message_id, last_message_at,
          last_message_preview, unread_count, created_at, updated_at
        ) VALUES (?, 'discord', 'default', ?, ?, ?, 1, NULL, ?, NULL, '[]', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run(
        "discord-group-dm",
        "discord:channel:group-dm-1",
        "group-dm-1",
        "group",
        "Jarvis, Ava",
        timestamp,
        timestamp,
      );
    sql
      .prepare(
        `
      INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          removal_reason, name, topic, participant_names, last_message_id, last_message_at,
          last_message_preview, unread_count, created_at, updated_at
        ) VALUES (?, 'discord', 'default', ?, ?, ?, 1, NULL, ?, NULL, '[]', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run(
        "discord-channel",
        "discord:channel:guild-1",
        "guild-1",
        "channel",
        "general",
        timestamp,
        timestamp,
      );

    expect(db.resolveDiscordSendTarget("Jarvis")).toEqual({
      target: "dm-1",
      threadId: "discord:channel:dm-1",
      resolution: "conversation_name",
      matchedConversationId: "discord-dm",
      matchedName: "Jarvis",
    });
    expect(db.resolveDiscordSendTarget("Jarvis, Ava")).toEqual({
      target: "group-dm-1",
      threadId: "discord:channel:group-dm-1",
      resolution: "conversation_name",
      matchedConversationId: "discord-group-dm",
      matchedName: "Jarvis, Ava",
    });
    expect(db.resolveDiscordSendTarget("dm-1")).toEqual({
      target: "dm-1",
      threadId: "discord:channel:dm-1",
      resolution: "channel_id",
      matchedConversationId: "discord-dm",
      matchedName: "Jarvis",
    });
    expect(db.resolveDiscordSendTarget("discord:channel:dm-1")).toEqual({
      target: "dm-1",
      threadId: "discord:channel:dm-1",
      resolution: "source_conversation_key",
      matchedConversationId: "discord-dm",
      matchedName: "Jarvis",
    });
    expect(db.resolveDiscordSendTarget("general")).toBeNull();
    expect(db.resolveDiscordSendTarget("guild-1")).toBeNull();

    db.close();
  });

  it("records contact merge actions and resolves canonical contact chains", () => {
    const db = createDb();

    insertContact(db, { id: "contact-a", name: "Ava Prime" });
    insertContact(db, { id: "contact-b", name: "Ava Duplicate" });
    insertContact(db, { id: "contact-c", name: "Ava Canonical" });

    expect(
      executeContactMerge(db, {
        primaryContactId: "contact-a",
        secondaryContactId: "contact-b",
        reason: "same phone",
      }),
    ).toEqual({
      decisionId: expect.any(String),
      primaryContactId: "contact-a",
      secondaryContactId: "contact-b",
      canonicalContactId: "contact-a",
    });
    expect(
      executeContactMerge(db, {
        primaryContactId: "contact-c",
        secondaryContactId: "contact-a",
        reason: "prefer contacts source",
      }),
    ).toEqual({
      decisionId: expect.any(String),
      primaryContactId: "contact-c",
      secondaryContactId: "contact-a",
      canonicalContactId: "contact-c",
    });

    expect(db.listContactMergeAliases()).toEqual([
      { contact_id: "contact-b", canonical_contact_id: "contact-a" },
      { contact_id: "contact-a", canonical_contact_id: "contact-c" },
    ]);
    expect(db.listContactMergeAliases()).toHaveLength(2);

    db.close();
  });

  it("moves secondary contact memories to the canonical contact on merge", () => {
    const db = createDb();
    insertContact(db, { id: "contact-a", name: "Ava Prime" });
    insertContact(db, { id: "contact-b", name: "Ava Duplicate" });
    const memory = db.addContactMemory({
      contactId: "contact-b",
      body: "Prefers short follow-ups.",
      sourceKind: "local_messages",
      createdBy: "test",
    });

    executeContactMerge(db, {
      primaryContactId: "contact-a",
      secondaryContactId: "contact-b",
      reason: "same email",
    });

    expect(db.listContactMemories({ contactId: "contact-a" }).map((row) => row.id)).toEqual([
      memory.id,
    ]);
    expect(db.listContactMemories({ contactId: "contact-b" })).toEqual([]);

    db.close();
  });

  it("queues, claims, and finishes sync runs", () => {
    const db = createDb();

    const runId = db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "manual",
      details: { requestId: "abc" },
    });

    expect(db.hasQueuedOrRunningRun("contacts")).toBe(true);
    const queuedRun = db.listRecentRuns(1)[0]!;
    expect(queuedRun).toEqual(
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "queued",
        started_at: null,
        finished_at: null,
      }),
    );
    expect(queuedRun.queued_at).toEqual(expect.any(Number));

    const claimedRun = db.claimNextQueuedRun();
    expect(claimedRun).toEqual(
      expect.objectContaining({
        id: runId,
        platform: "contacts",
        account_key: "local",
        run_type: "sync",
        status: "ingesting",
        queued_at: queuedRun.queued_at,
        details_json: JSON.stringify({ requestId: "abc" }),
        attempt: 1,
        owner_id: null,
      }),
    );
    expect(claimedRun?.started_at).toEqual(expect.any(Number));
    expect(claimedRun?.started_at).toBeGreaterThanOrEqual(claimedRun?.queued_at ?? 0);

    db.finishRun(runId, { projected: 3 });
    expect(db.listRecentRuns(1)[0]).toEqual(
      expect.objectContaining({
        id: runId,
        status: "completed",
        queued_at: queuedRun.queued_at,
        started_at: claimedRun?.started_at,
        finished_at: expect.any(Number),
      }),
    );

    const failedId = db.queueSyncRun({
      platform: "linkedin",
      accountKey: "default",
      runType: "sync",
      trigger: "manual",
    });
    db.failRun(failedId, "boom", { code: "x" });
    expect(db.listRecentRuns(2).some((run) => run.id === failedId && run.status === "failed")).toBe(
      true,
    );
    expect(db.getLatestSyncRunError("linkedin", "default")).toEqual({
      sync_run_id: failedId,
      error_message: "boom",
      created_at: expect.any(Number),
      details_json: JSON.stringify({ code: "x" }),
    });
    expect(
      sqlite(db)
        .prepare(
          "SELECT status, owner_id, lease_expires_at, error_code FROM sync_runs WHERE id = ?",
        )
        .get(failedId),
    ).toEqual({
      status: "failed",
      owner_id: null,
      lease_expires_at: null,
      error_code: null,
    });

    db.close();
  });

  it("reclaims expired sync run leases automatically", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });

    expect(
      db.claimNextQueuedRun(["sync"], "ingesting", {
        ownerId: "daemon-a",
        leaseMs: 10_000,
      }),
    ).toEqual(expect.objectContaining({ id: runId, attempt: 1, owner_id: "daemon-a" }));
    expect(db.claimNextQueuedRun(["sync"], "ingesting")).toBeNull();

    sqlite(db).prepare("UPDATE sync_runs SET lease_expires_at = 1 WHERE id = ?").run(runId);
    expect(
      db.claimNextQueuedRun(["sync"], "ingesting", {
        ownerId: "daemon-b",
        leaseMs: 20_000,
      }),
    ).toEqual(expect.objectContaining({ id: runId, attempt: 2, owner_id: "daemon-b" }));
    expect(
      db.finishRun(runId, undefined, {
        ownerId: "daemon-a",
        attempt: 1,
      }),
    ).toBe(false);
    expect(
      sqlite(db).prepare("SELECT status, owner_id, attempt FROM sync_runs WHERE id = ?").get(runId),
    ).toEqual({ status: "ingesting", owner_id: "daemon-b", attempt: 2 });

    expect(db.finishRun(runId, undefined, { ownerId: "daemon-b", attempt: 2 })).toBe(true);
    expect(
      sqlite(db)
        .prepare("SELECT status, owner_id, lease_expires_at FROM sync_runs WHERE id = ?")
        .get(runId),
    ).toEqual({ status: "completed", owner_id: null, lease_expires_at: null });

    db.close();
  });

  it("reports queued and expired sync runs as future claimable wakeups", () => {
    const db = createDb();
    const timestamp = Date.now();
    const queuedRunId = db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "scheduler",
      scheduledAt: timestamp + 60_000,
    });
    const runningRunId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });
    db.claimNextQueuedRun(["sync"], "ingesting", {
      ownerId: "daemon-a",
      leaseMs: 30_000,
    });
    sqlite(db)
      .prepare("UPDATE sync_runs SET lease_expires_at = ? WHERE id = ?")
      .run(timestamp + 30_000, runningRunId);

    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBe(timestamp + 30_000);
    db.failRun(runningRunId, "forced", undefined, "forced");
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeGreaterThanOrEqual(timestamp);
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeLessThanOrEqual(timestamp + 60_000);

    db.failRun(queuedRunId, "forced", undefined, "forced");
    expect(db.getNextClaimableRunAt(["sync"], "ingesting")).toBeNull();

    db.close();
  });

  it("recovers in-progress sync runs as queued after daemon restart", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync",
      trigger: "scheduler",
    });
    db.claimNextQueuedRun(["sync"], "ingesting", {
      ownerId: "daemon-before-restart",
      leaseMs: 60_000,
    });

    expect(db.recoverInProgressRuns()).toBe(1);
    expect(
      sqlite(db)
        .prepare(
          `
          SELECT status, owner_id, lease_expires_at, error_code
          FROM sync_runs
          WHERE id = ?
        `,
        )
        .get(runId),
    ).toEqual({
      status: "queued",
      owner_id: null,
      lease_expires_at: null,
      error_code: "daemon_recovered",
    });
    expect(db.claimNextQueuedRun(["sync"], "ingesting")).toEqual(
      expect.objectContaining({ id: runId, attempt: 2 }),
    );

    db.close();
  });

  it("does not claim queued sync runs before their scheduled time", () => {
    const db = createDb();
    const futureRunId = db.queueSyncRun({
      platform: "slack",
      accountKey: "T123",
      runType: "sync_resume",
      trigger: "ingest_continue",
      delayMs: 60_000,
    });

    expect(db.claimNextQueuedRun(["sync_resume"])).toBeNull();
    const nextScheduledAt = db.getNextQueuedRunScheduledAt(["sync_resume"]);
    expect(nextScheduledAt).toBeGreaterThan(Date.now());

    db.queueSyncRun({
      platform: "contacts",
      accountKey: "local",
      runType: "sync",
      trigger: "manual",
    });

    expect(db.claimNextQueuedRun(["sync"])?.platform).toBe("contacts");
    expect(db.listRecentRuns(5).find((run) => run.id === futureRunId)?.status).toBe("queued");

    db.close();
  });

  it("reschedules queued sync runs", () => {
    const db = createDb();
    const runId = db.queueSyncRun({
      runType: "project",
      trigger: "projection_continue",
      delayMs: 60_000,
    });

    expect(db.claimNextQueuedRun(["project"])).toBeNull();

    db.rescheduleRun(runId, Date.now() - 1);
    expect(db.claimNextQueuedRun(["project"])?.id).toBe(runId);

    db.close();
  });

  it("stores checkpoints and raw events", () => {
    const db = createDb();

    db.upsertSourceAccount({
      platform: "contacts",
      accountKey: "local",
      displayName: "macOS Contacts",
    });
    db.upsertCheckpoint({
      platform: "contacts",
      accountKey: "local",
      syncMode: "full",
      sourceCursor: { snapshotAt: 123 },
      rawIngestWatermark: 5,
      lastSuccessAt: 1_700_000_000_000,
    });
    db.upsertCheckpoint({
      platform: "contacts",
      accountKey: "local",
      syncMode: "incremental",
      sourceCursor: { snapshotAt: 456 },
      rawIngestWatermark: 6,
      lastSuccessAt: 1_700_000_000_500,
      lastErrorSummary: "none",
    });

    const rawEventId = randomUUID();
    db.insertRawEvent({
      id: rawEventId,
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1_700_000_000_000,
      dedupeKey: "contacts:1",
      payload: {
        sourceEntityKey: "contacts:1",
        fields: { display_name: "Ava" },
        handles: [],
      },
      sourceVersion: "contacts-v1",
    });

    expect(db.getCheckpoint("contacts", "local")).toEqual({
      source_cursor_json: JSON.stringify({ snapshotAt: 456 }),
      sync_mode: "incremental",
      raw_ingest_watermark: 6,
      last_success_at: 1_700_000_000_500,
      last_error_summary: "none",
    });
    expect(db.getCheckpoint("contacts", "local")).not.toHaveProperty("projection_watermark");
    expect(db.listCheckpointSummary()).toEqual([
      {
        platform: "contacts",
        account_key: "local",
        sync_mode: "incremental",
        last_success_at: 1_700_000_000_500,
        last_error_summary: "none",
      },
    ]);
    db.recordCheckpointError("contacts", "local", "sync failed");
    expect(db.getCheckpoint("contacts", "local")).toEqual({
      source_cursor_json: JSON.stringify({ snapshotAt: 456 }),
      sync_mode: "incremental",
      raw_ingest_watermark: 6,
      last_success_at: 1_700_000_000_500,
      last_error_summary: "sync failed",
    });
    expect(db.listCheckpointPlatforms()).toEqual(["contacts"]);
    expect(db.listRawEvents()).toEqual([
      {
        id: rawEventId,
        platform: "contacts",
        account_key: "local",
        entity_kind: "contact",
        event_kind: "observed",
        normalized_schema: "contact.observed@1",
        provenance_json: null,
        observed_at: 1_700_000_000_000,
        payload_json: JSON.stringify({
          sourceEntityKey: "contacts:1",
          fields: { display_name: "Ava" },
          handles: [],
        }),
      },
    ]);

    expect(db.getProjectionState()).toEqual({
      singleton_key: "global",
      projection_watermark: 0,
      last_projected_at: null,
      last_rebuild_at: null,
      updated_at: expect.any(Number),
    });
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 1,
      pending_raw_events: 1,
    });
    expect(
      sqlite(db)
        .prepare("SELECT COUNT(*) AS count FROM projection_state WHERE singleton_key = 'global'")
        .get(),
    ).toEqual({ count: 1 });

    db.close();
  });

  it("stores source version separately from provenance metadata", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "raw-event-source-version",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 1_710_000_000_000,
      dedupeKey: "linkedin:source-version",
      payload: {
        sourceMessageKey: "msg-source-version",
        sourceConversationKey: "thread-source-version",
        senderSourceKey: "linkedin:member:ava",
        sentAt: 1_710_000_000_000,
        content: "hello",
      },
      sourceVersion: "linkedin-v7",
      provenance: {
        acquisitionMode: "realtime",
        providerApiVersion: "2026-03",
        adapterVersion: "linkedin-adapter@7",
      },
    });

    const row = sqlite(db)
      .prepare(
        `
          SELECT source_version, provenance_json
          FROM raw_events
          WHERE id = ?
        `,
      )
      .get("raw-event-source-version") as {
      source_version: string | null;
      provenance_json: string | null;
    };

    expect(row).toEqual({
      source_version: "linkedin-v7",
      provenance_json: JSON.stringify({
        providerApiVersion: "2026-03",
        adapterVersion: "linkedin-adapter@7",
        acquisitionMode: "realtime",
      }),
    });

    db.close();
  });

  it("upgrades existing databases with refactor columns and lifecycle state", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-upgrade-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      `INSERT INTO schema_migrations (id, applied_at) VALUES ('0014_messages_fts_rowid_alignment', 1)`,
    );
    sql.exec(`
      CREATE TABLE raw_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        external_event_id TEXT,
        external_entity_id TEXT,
        conversation_external_id TEXT,
        occurred_at INTEGER,
        observed_at INTEGER NOT NULL,
        cursor_json TEXT,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_version TEXT,
        UNIQUE(platform, account_key, dedupe_key)
      )
    `);
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        native_conversation_key TEXT,
        type TEXT NOT NULL,
        subtype TEXT,
        service TEXT,
        name TEXT,
        topic TEXT,
        participant_names TEXT,
        last_message_id TEXT,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_conversation_key)
      )
    `);
    sql.exec(`
      CREATE TABLE timeline_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        actor_contact_id TEXT,
        actor_source_key TEXT,
        actor_name TEXT,
        subject_contact_id TEXT,
        event_at INTEGER NOT NULL,
        text TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_event_key)
      )
    `);
    sql
      .prepare(`
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'linkedin', 'default', ?, NULL, 'dm', 'deleted', 'linkedin', 'Thread', NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `)
      .run("legacy-conversation", "thread-1", 1, 1);

    db.migrate();

    const rawEventColumns = (
      sql.prepare("PRAGMA table_info(raw_events)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const conversationColumns = (
      sql.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const timelineColumns = (
      sql.prepare("PRAGMA table_info(timeline_events)").all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(rawEventColumns).toEqual(
      expect.arrayContaining(["normalized_schema", "provenance_json"]),
    );
    expect(conversationColumns).toContain("is_active");
    expect(conversationColumns).toContain("removal_reason");
    expect(timelineColumns).toContain("subject_source_key");
    expect(timelineColumns).toContain("system_kind");
    expect(timelineColumns).toContain("call_provider");
    expect(timelineColumns).toContain("call_direction");
    expect(timelineColumns).toContain("call_status");
    expect(timelineColumns).toContain("call_medium");
    expect(timelineColumns).toContain("call_started_at");
    expect(timelineColumns).toContain("call_duration_seconds");
    expect(timelineColumns).toContain("call_ended_at");
    expect(timelineColumns).toContain("call_disconnected_cause");
    expect(
      sql
        .prepare("SELECT is_active, removal_reason FROM conversations WHERE id = ?")
        .get("legacy-conversation"),
    ).toEqual({ is_active: 0, removal_reason: "deleted" });

    db.close();
  });

  it("repairs removal_reason for databases that already marked 0002 applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-removal-reason-repair-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('0001_bootstrap_current_schema', 1), ('0002_upgrade_existing_schema_columns', 2)
    `);
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_conversation_key TEXT NOT NULL,
        native_conversation_key TEXT,
        type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        service TEXT,
        name TEXT,
        topic TEXT,
        participant_names TEXT,
        last_message_id TEXT,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_conversation_key)
      )
    `);

    db.migrate();

    const conversationColumns = (
      sql.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(conversationColumns).toContain("removal_reason");
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0003_repair_conversation_removal_reason"),
    ).toBeTruthy();

    db.close();
  });

  it("repairs partially migrated legacy databases after the squash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-v2-partial-legacy-repair-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('0010_requestable_sync_capable_backfill', 1)
    `);
    sql.exec(`
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        account_key TEXT,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        details_json TEXT
      )
    `);
    sql.exec(`
      CREATE TABLE sync_run_errors (
        id TEXT PRIMARY KEY,
        sync_run_id TEXT NOT NULL,
        platform TEXT,
        account_key TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO sync_runs (
        id, platform, account_key, run_type, status, trigger, started_at, finished_at, details_json
      ) VALUES ('legacy-run', 'slack', 'default', 'sync', 'queued', 'scheduler', 123, NULL, '{}')
    `);
    sql.exec(`
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        source_attachment_key TEXT NOT NULL,
        kind TEXT,
        mime_type TEXT,
        filename TEXT,
        title TEXT,
        local_path TEXT,
        remote_url TEXT,
        size_bytes INTEGER,
        text_content TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_key, source_attachment_key)
      )
    `);

    db.migrate();

    const syncRunColumns = (
      sql.prepare("PRAGMA table_info(sync_runs)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const messageAttachmentColumns = (
      sql.prepare("PRAGMA table_info(message_attachments)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const tables = (
      sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    const synchronousProjectionTriggerRows = sql
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN (
            'trg_messages_inserted_fts',
            'trg_messages_updated_fts',
            'trg_messages_deleted_fts',
            'trg_message_attachments_inserted',
            'trg_message_attachments_updated',
            'trg_message_attachments_deleted',
            'trg_message_reactions_inserted',
            'trg_message_reactions_updated',
            'trg_message_reactions_deleted',
            'trg_contacts_name_updated',
            'trg_conversations_name_updated',
            'trg_conversation_participants_inserted',
            'trg_conversation_participants_updated',
            'trg_conversation_participants_deleted'
          )
      `,
      )
      .all() as Array<{ name: string }>;

    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0001_bootstrap_current_schema"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0004_repair_partial_legacy_bootstrap"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0007_add_generic_sync_proof_tables"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0008_migrate_slack_backfill_proofs_to_generic"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0009_add_contact_fanout_projection_indexes"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0010_add_timeline_call_fields"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0016_drop_synchronous_message_fts_triggers"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0017_drop_remaining_projection_side_effect_triggers"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0018_add_projection_hot_path_indexes"),
    ).toBeTruthy();
    const indexNames = (
      sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "idx_conversation_participants_contact",
        "idx_conversation_participants_conversation_active_self",
        "idx_conversation_participants_conversation_contact_active_updated",
        "idx_conversation_participants_source_key_lower",
        "idx_timeline_events_actor_contact",
        "idx_timeline_events_conversation_latest_system",
        "idx_message_reactions_reactor_contact",
        "idx_messages_conversation_latest",
        "idx_messages_conversation_unread",
        "idx_messages_sender_source_key_lower",
      ]),
    );
    expect(syncRunColumns).toEqual(expect.arrayContaining(["queued_at", "scheduled_at"]));
    expect(
      sql
        .prepare("SELECT queued_at, scheduled_at, started_at FROM sync_runs WHERE id = ?")
        .get("legacy-run"),
    ).toEqual({ queued_at: 123, scheduled_at: 123, started_at: null });
    expect(syncRunColumns).toEqual(
      expect.arrayContaining([
        "attempt",
        "owner_id",
        "lease_expires_at",
        "last_progress_at",
        "error_code",
      ]),
    );
    expect(messageAttachmentColumns).toEqual(
      expect.arrayContaining([
        "access_kind",
        "access_ref_json",
        "preview_ref_json",
        "availability_status",
        "provider_metadata_json",
      ]),
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        "slack_backfill_proofs",
        "sync_scopes",
        "sync_proofs",
        "jobs",
        "message_fts_index_queue",
        "attachment_cache",
        "attachment_content",
        "projection_state",
        "messages_fts",
      ]),
    );
    expect(synchronousProjectionTriggerRows).toEqual([]);

    db.close();
  });

  it("honors the pre-renumbered Discord fanout index migration id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-discord-fanout-legacy-id-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("0008_add_contact_fanout_projection_indexes", 1);

    db.migrate();

    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0008_add_contact_fanout_projection_indexes"),
    ).toBeTruthy();
    expect(
      sql
        .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
        .get("0009_add_contact_fanout_projection_indexes"),
    ).toBeUndefined();

    db.close();
  });

  it("adds contact memories to existing migrated databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-contact-memories-migration-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    const sql = sqlite(db);

    sql.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      INSERT INTO schema_migrations (id, applied_at)
      VALUES
        ('0001_bootstrap_current_schema', 1),
        ('0002_upgrade_existing_schema_columns', 2),
        ('0003_repair_conversation_removal_reason', 3),
        ('0004_repair_partial_legacy_bootstrap', 4),
        ('0005_add_contact_merge_decisions', 5),
        ('0006_rename_contact_merge_columns', 6),
        ('0007_add_generic_sync_proof_tables', 7),
        ('0008_migrate_slack_backfill_proofs_to_generic', 8),
        ('0009_add_contact_fanout_projection_indexes', 9),
        ('0010_add_timeline_call_fields', 10),
        ('0011_remove_telegram_runtime_state', 11)
    `);
    sql.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        name TEXT,
        photo_url TEXT,
        company TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.migrate();

    const memoryColumns = (
      sql.prepare("PRAGMA table_info(contact_memories)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);

    expect(memoryColumns).toEqual(
      expect.arrayContaining([
        "contact_id",
        "body",
        "source_kind",
        "evidence_json",
        "confidence",
        "supersedes_memory_id",
        "stale_at",
        "created_at",
      ]),
    );
    expect(
      sql.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get("0012_contact_memories"),
    ).toBeTruthy();
    const contactForeignKeys = (
      sql.prepare("PRAGMA foreign_key_list(contact_memories)").all() as Array<{ table: string }>
    ).filter((foreignKey) => foreignKey.table === "contacts");
    expect(contactForeignKeys).toEqual([]);

    db.close();
  });

  it("batches source account and raw event writes without duplicating rows", () => {
    const db = createDb();

    db.upsertSourceAccounts([
      {
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
      },
      {
        platform: "slack",
        accountKey: "default",
        displayName: "Slack Updated",
      },
    ]);

    const insertResult = db.insertRawEvents([
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1", sourceConversationKey: "c1" },
      },
      {
        id: "event-1",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "event-1",
        payload: { sourceMessageKey: "m1", sourceConversationKey: "c1" },
      },
      {
        id: "event-2",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 101,
        dedupeKey: "event-2",
        payload: { sourceMessageKey: "m2", sourceConversationKey: "c1" },
      },
    ]);

    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getIntegrationState("slack", "default")).toBeNull();
    expect(insertResult.insertedCount).toBe(2);
    expect(insertResult.insertedEvents.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(insertResult.firstInsertedRowId).toBe(1);
    expect(insertResult.lastInsertedRowId).toBe(2);
    expect(db.listRawEvents().map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(db.listRawEvents().map((event) => event.normalized_schema)).toEqual([
      "message.created@1",
      "message.created@1",
    ]);

    db.close();
  });

  it("counts only dedupe-inserted raw events in batched writes", () => {
    const db = createDb();

    const duplicateDedupeKey = `contacts:duplicate:${randomUUID()}`;
    const result = db.insertRawEvents([
      {
        id: randomUUID(),
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: duplicateDedupeKey,
        payload: {
          sourceEntityKey: "contacts:one",
          fields: { display_name: "One" },
          handles: [{ type: "phone", value: "+15551234567", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      },
      {
        id: randomUUID(),
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 2,
        dedupeKey: duplicateDedupeKey,
        payload: {
          sourceEntityKey: "contacts:one",
          fields: { display_name: "One" },
          handles: [{ type: "phone", value: "+15551234567", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      },
    ]);

    expect(result.insertedCount).toBe(1);
    expect(result.insertedEvents).toHaveLength(1);
    expect(db.getOverview().rawEvents).toBe(1);

    db.close();
  });

  it("resets platform raw state without rebuilding projections inline", () => {
    const db = createDb();
    const timestamp = Date.now();

    db.upsertSourceAccounts([
      { platform: "linkedin", accountKey: "default", displayName: "LinkedIn" },
      { platform: "slack", accountKey: "default", displayName: "Slack" },
    ]);

    db.insertRawEvents([
      {
        id: "linkedin-reset-raw",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: timestamp,
        dedupeKey: "linkedin-reset-raw",
        payload: { sourceMessageKey: "linkedin:m1", sourceConversationKey: "linkedin:c1" },
      },
      {
        id: "slack-reset-raw",
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: timestamp + 1,
        dedupeKey: "slack-reset-raw",
        payload: { sourceMessageKey: "slack:m1", sourceConversationKey: "slack:c1" },
      },
    ]);

    insertContact(db, { id: "contact-reset-1", name: "Reset Contact", updatedAt: timestamp });
    db.upsertProjectionState({
      projectionWatermark: 2,
      lastProjectedAt: timestamp,
      lastRebuildAt: timestamp,
    });

    expect(db.getOverview().contacts).toBe(1);
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 2,
      max_raw_event_rowid: 2,
      pending_raw_events: 0,
    });

    const removed = db.resetSource("linkedin");

    expect(removed).toBe(2);
    expect(db.getOverview().contacts).toBe(1);
    expect(db.getOverview().rawEvents).toBe(1);
    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getCheckpoint("linkedin", "default")).toBeNull();
    expect(
      sqlite(db)
        .prepare("SELECT count(*) AS count FROM raw_events WHERE platform = 'linkedin'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite(db).prepare("SELECT count(*) AS count FROM raw_events WHERE platform = 'slack'").get(),
    ).toEqual({ count: 1 });
    expect(db.getProjectionBacklog()).toEqual({
      projection_watermark: 0,
      max_raw_event_rowid: 2,
      pending_raw_events: 2,
    });

    db.close();
  });

  it("removes cached attachment files when clearing projected state", () => {
    const db = createDb();
    const timestamp = Date.now();
    const cacheDir = mkdtempSync(join(tmpdir(), "cued-attachment-cache-"));
    tempDirs.push(cacheDir);
    const cachePath = join(cacheDir, "cached.txt");
    writeFileSync(cachePath, "cached attachment payload");

    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, is_active,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', 1, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-cache-1", "source-conversation-cache-1", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run(
        "message-cache-1",
        "platform-message-cache-1",
        "conversation-cache-1",
        timestamp,
        timestamp,
        timestamp,
      );
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'cached.txt', 'Cached', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-cache-1",
        "message-cache-1",
        "source-attachment-cache-1",
        cachePath,
        25,
        JSON.stringify({ path: cachePath }),
        timestamp,
        timestamp,
      );
    db.upsertAttachmentCacheEntry({
      attachmentId: "attachment-cache-1",
      variant: "original",
      status: "ready",
      cachePath,
      mimeType: "text/plain",
      sizeBytes: 25,
      sha256: "abc123",
      fetchedAt: timestamp,
      lastAccessedAt: timestamp,
    });

    db.clearProjectedState();

    expect(existsSync(cachePath)).toBe(false);
    expect(db.getAttachmentCacheEntry("attachment-cache-1", "original")).toBeNull();

    db.close();
  });
});
