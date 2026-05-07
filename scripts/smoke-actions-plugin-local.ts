import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionDefinitionRegistry } from "../src/actions/registry.js";
import { CuedDatabase, openCuedDatabaseReadOnly } from "../src/db/database.js";
import { installLocalCuedSkill } from "../src/skills/install.js";

type ContactRow = {
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

function writeSmokeExecutor(actionsRoot: string, effectType: string): void {
  writeFileSync(
    join(actionsRoot, "smoke-contact-note.cjs"),
    `
function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const contactId = helpers.requiredStringPayload(payload, "contactId", action);
  if (!db.contactExists(contactId)) {
    throw new Error(\`Contact not found: \${contactId}\`);
  }
  const note = {
    contactId,
    note: helpers.requiredStringPayload(payload, "note", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "${effectType}",
    targetTable: "contacts",
    targetId: contactId,
    payload: note,
  });
  return { result: { note }, effects: [effect] };
}

module.exports = { execute };
`.trimStart(),
    "utf8",
  );
}

function writeLocalSkill(parentDir: string): string {
  const skillRoot = join(parentDir, "smoke-local");
  const actionsRoot = join(skillRoot, "actions");
  mkdirSync(actionsRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: smoke-local\ndescription: Local action smoke skill\n---\n",
    "utf8",
  );
  writeFileSync(
    join(actionsRoot, "smoke.contact.note.json"),
    JSON.stringify(
      {
        type: "smoke.contact.note",
        version: "1",
        description: "Record a smoke-only contact note effect",
        module: "actions/smoke-contact-note.cjs",
        requiresApprovalDefault: false,
        payload: {
          required: {
            contactId: "string",
            note: "string",
          },
          optional: {
            evidence: "object",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeSmokeExecutor(actionsRoot, "smoke.contact.note.recorded");
  return skillRoot;
}

const originalCuedHome = process.env.CUED_HOME;
const tempDir = mkdtempSync(join(tmpdir(), "cued-actions-plugin-local-"));
const cuedHome = join(tempDir, "home");
const sandboxPath = join(tempDir, "local.db");
const realDb = openCuedDatabaseReadOnly();
let sandboxDb: CuedDatabase | null = null;

try {
  const contacts = realDb.executeReadOnlySql(`
    SELECT id, name
    FROM contacts
    WHERE archived = 0
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `) as ContactRow[];
  assert(contacts.length === 1, "Expected at least one real contact for plugin smoke.");

  const sourceSkillRoot = writeLocalSkill(join(tempDir, "source-skills"));
  process.env.CUED_HOME = cuedHome;
  const installed = installLocalCuedSkill(sourceSkillRoot);
  assert(installed.ok, installed.error ?? "Expected local smoke skill install to succeed.");

  const registry = ActionDefinitionRegistry.load();
  const definition = registry.get("smoke.contact.note");
  assert(definition, "Expected local smoke action definition to load.");
  assert(
    definition.skillRoot === installed.installedPath,
    "Expected action definition to resolve from local skill.",
  );

  sandboxDb = new CuedDatabase(sandboxPath);
  sandboxDb.initializeSchema();
  insertContact(sandboxDb, contacts[0]!);

  const firstAction = sandboxDb.createAction({
    actionType: "smoke.contact.note",
    payload: {
      contactId: contacts[0]!.id,
      note: "Local plugin smoke. Temp DB only.",
      evidence: { source: "smoke-actions-plugin-local" },
    },
    sourceSkill: definition.skillName,
    createdBy: "plugin-smoke",
    requiresApproval: false,
  });
  const firstExecuted = sandboxDb.executeApprovedAction(firstAction.id, "plugin-smoke");

  writeSmokeExecutor(join(installed.installedPath, "actions"), "smoke.contact.note.modified");
  const secondAction = sandboxDb.createAction({
    actionType: "smoke.contact.note",
    payload: {
      contactId: contacts[0]!.id,
      note: "Modified local plugin smoke. Temp DB only.",
      evidence: { source: "smoke-actions-plugin-local", modified: true },
    },
    sourceSkill: definition.skillName,
    createdBy: "plugin-smoke",
    requiresApproval: false,
  });
  const secondExecuted = sandboxDb.executeApprovedAction(secondAction.id, "plugin-smoke");
  const effects = [
    ...sandboxDb.listActionEffects(firstAction.id),
    ...sandboxDb.listActionEffects(secondAction.id),
  ];

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        realDatabaseReadonly: true,
        sourceSkillRoot,
        localSkillRoot: installed.installedPath,
        loadedActionType: definition.type,
        executedActionStatuses: [firstExecuted.action.status, secondExecuted.action.status],
        effectTypes: effects.map((effect) => effect.effect_type),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  sandboxDb?.close();
  realDb.close();
  if (originalCuedHome === undefined) {
    delete process.env.CUED_HOME;
  } else {
    process.env.CUED_HOME = originalCuedHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
}
