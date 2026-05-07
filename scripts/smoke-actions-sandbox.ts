import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuedDatabase, openCuedDatabaseReadOnly } from "../src/db/database.js";

type ContactRow = {
  id: string;
  name: string | null;
};

type ConversationRow = {
  id: string;
  name: string | null;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sqlite(db: CuedDatabase) {
  return (
    db as unknown as {
      sqlite: {
        prepare: (sql: string) => {
          run: (...params: unknown[]) => void;
          get: (...params: unknown[]) => unknown;
        };
      };
    }
  ).sqlite;
}

function insertContact(db: CuedDatabase, contact: ContactRow): void {
  const timestamp = Date.now();
  sqlite(db)
    .prepare(
      `
      INSERT INTO contacts (id, kind, name, photo_url, company, archived, created_at, updated_at)
      VALUES (?, 'person', ?, NULL, NULL, 0, ?, ?)
    `,
    )
    .run(contact.id, contact.name, timestamp, timestamp);
}

function insertConversation(db: CuedDatabase, conversation: ConversationRow): void {
  const timestamp = Date.now();
  sqlite(db)
    .prepare(
      `
      INSERT INTO conversations (
        id, platform, account_key, source_conversation_key, native_conversation_key, type,
        is_active, removal_reason, service, name, topic, participant_names, last_message_id,
        last_message_at, last_message_preview, unread_count, created_at, updated_at
      ) VALUES (?, 'imessage', 'default', ?, NULL, 'dm', 1, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
    `,
    )
    .run(conversation.id, `sandbox:${conversation.id}`, conversation.name, timestamp, timestamp);
}

function executeAutoApproved(
  db: CuedDatabase,
  actionType: string,
  payload: Record<string, unknown>,
) {
  const action = db.createAction({
    actionType,
    payload,
    requiresApproval: false,
    sourceSkill: "cued",
    createdBy: "sandbox-smoke",
  });
  return db.executeApprovedAction(action.id, "sandbox-smoke");
}

const realDb = openCuedDatabaseReadOnly();
const tempDir = mkdtempSync(join(tmpdir(), "cued-actions-sandbox-"));
let sandboxDb: CuedDatabase | null = null;

try {
  const contacts = realDb.executeReadOnlySql(`
    SELECT id, name
    FROM contacts
    WHERE archived = 0
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 2
  `) as ContactRow[];
  const conversations = realDb.executeReadOnlySql(`
    SELECT id, name
    FROM conversations
    WHERE is_active = 1
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `) as ConversationRow[];

  assert(contacts.length >= 2, "Expected at least two real contacts for sandbox smoke.");
  assert(conversations.length >= 1, "Expected at least one real conversation for sandbox smoke.");

  sandboxDb = new CuedDatabase(join(tempDir, "local.db"));
  sandboxDb.initializeSchema();
  for (const contact of contacts) {
    insertContact(sandboxDb, contact);
  }
  insertConversation(sandboxDb, conversations[0]!);

  const contactId = contacts[0]!.id;
  const otherContactId = contacts[1]!.id;
  const conversationId = conversations[0]!.id;
  const memoryAdded = executeAutoApproved(sandboxDb, "contact.memory.add", {
    contactId,
    body: "Sandbox smoke memory. Temp DB only.",
    sourceKind: "sandbox_smoke",
    evidence: { source: "smoke-actions-sandbox" },
    confidence: 50,
  });
  const memoryId =
    typeof memoryAdded.result === "object" &&
    memoryAdded.result !== null &&
    "memory" in memoryAdded.result &&
    typeof memoryAdded.result.memory === "object" &&
    memoryAdded.result.memory !== null &&
    "id" in memoryAdded.result.memory &&
    typeof memoryAdded.result.memory.id === "string"
      ? memoryAdded.result.memory.id
      : null;
  assert(memoryId, "Expected contact.memory.add smoke to return a memory id.");

  const results = [
    memoryAdded,
    executeAutoApproved(sandboxDb, "contact.memory.stale", {
      memoryId,
    }),
    executeAutoApproved(sandboxDb, "contact.merge", {
      primaryContactId: contactId,
      secondaryContactId: otherContactId,
      reason: "Sandbox smoke merge. Temp DB only.",
    }),
    executeAutoApproved(sandboxDb, "contact.memory.add", {
      contactId,
      body: "Sandbox smoke post-merge memory. Temp DB only.",
      sourceKind: "sandbox_smoke",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
    executeAutoApproved(sandboxDb, "contact.followup.recommend", {
      contactId,
      reason: "Sandbox smoke follow-up. Temp DB only.",
      suggestedMessage: "Sandbox smoke draft.",
      evidence: { source: "smoke-actions-sandbox" },
    }),
    executeAutoApproved(sandboxDb, "contact.enrichment.recommend", {
      contactId,
      field: "profile_url",
      value: "https://example.invalid/sandbox",
      sourceKind: "sandbox_smoke",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
    executeAutoApproved(sandboxDb, "contact.introduction.recommend", {
      fromContactId: contactId,
      toContactId: otherContactId,
      reason: "Sandbox smoke introduction. Temp DB only.",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
    executeAutoApproved(sandboxDb, "contact.message.draft", {
      contactId,
      body: "Sandbox smoke draft. Do not send.",
      reason: "Sandbox smoke message draft. Temp DB only.",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
    executeAutoApproved(sandboxDb, "conversation.summary.draft", {
      conversationId,
      summary: "Sandbox smoke conversation summary. Temp DB only.",
      reason: "Sandbox smoke summary draft.",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
    executeAutoApproved(sandboxDb, "conversation.followup.recommend", {
      conversationId,
      reason: "Sandbox smoke conversation follow-up. Temp DB only.",
      suggestedNextStep: "Review in sandbox only.",
      evidence: { source: "smoke-actions-sandbox" },
      confidence: 50,
    }),
  ];

  const effects = sandboxDb.executeReadOnlySql(`
    SELECT effect_type
    FROM action_effects
    ORDER BY applied_at ASC, id ASC
  `) as Array<{ effect_type: string }>;
  const sandboxActionCount = (
    sqlite(sandboxDb).prepare("SELECT COUNT(*) AS count FROM actions").get() as { count: number }
  ).count;

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        sandbox: true,
        realDatabaseReadonly: true,
        executedActionCount: results.length,
        sandboxActionCount,
        effectTypes: effects.map((effect) => effect.effect_type),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  sandboxDb?.close();
  realDb.close();
  rmSync(tempDir, { recursive: true, force: true });
}
