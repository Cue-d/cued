import { listContactMergeAliases } from "../src/actions/contact-merge-effects.js";
import { loadActionExecutor } from "../src/actions/executor-loader.js";
import { ActionDefinitionRegistry } from "../src/actions/registry.js";
import { openCuedDatabaseReadOnly } from "../src/db/database.js";

type ContactRow = {
  id: string;
  name: string | null;
};

type ConversationRow = {
  id: string;
  message_count: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const registry = ActionDefinitionRegistry.load();
const definitions = registry.list();
assert(definitions.length > 0, "Expected at least one action definition.");
for (const definition of definitions) {
  assert(
    loadActionExecutor(definition),
    `Missing executor for ${definition.type}@${definition.version}`,
  );
}

const db = openCuedDatabaseReadOnly();
try {
  const contacts = db.executeReadOnlySql(`
    SELECT id, name
    FROM contacts
    WHERE archived = 0
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 2
  `) as ContactRow[];

  const memoryValidation =
    contacts[0] != null
      ? registry.validatePayload("contact.memory.add", "1", {
          contactId: contacts[0].id,
          body: "Local action smoke validation only. Do not write.",
          sourceKind: "smoke",
        })
      : null;
  assert(
    memoryValidation == null || memoryValidation.ok,
    `contact.memory.add payload failed validation: ${memoryValidation?.errors.join("; ")}`,
  );

  const mergeValidation =
    contacts.length >= 2
      ? registry.validatePayload("contact.merge", "1", {
          primaryContactId: contacts[0]!.id,
          secondaryContactId: contacts[1]!.id,
          reason: "Local action smoke validation only. Do not write.",
        })
      : null;
  assert(
    mergeValidation == null || mergeValidation.ok,
    `contact.merge payload failed validation: ${mergeValidation?.errors.join("; ")}`,
  );

  const followupValidation =
    contacts[0] != null
      ? registry.validatePayload("contact.followup.recommend", "1", {
          contactId: contacts[0].id,
          reason: "Local action smoke validation only. Do not write.",
          suggestedMessage: "Local action smoke validation only.",
          evidence: { source: "smoke-actions-local" },
        })
      : null;
  assert(
    followupValidation == null || followupValidation.ok,
    `contact.followup.recommend payload failed validation: ${followupValidation?.errors.join(
      "; ",
    )}`,
  );

  const enrichmentValidation =
    contacts[0] != null
      ? registry.validatePayload("contact.enrichment.recommend", "1", {
          contactId: contacts[0].id,
          field: "profile_url",
          value: "Local action smoke validation only. Do not write.",
          sourceKind: "smoke",
          evidence: { source: "smoke-actions-local" },
        })
      : null;
  assert(
    enrichmentValidation == null || enrichmentValidation.ok,
    `contact.enrichment.recommend payload failed validation: ${enrichmentValidation?.errors.join(
      "; ",
    )}`,
  );

  const introductionValidation =
    contacts.length >= 2
      ? registry.validatePayload("contact.introduction.recommend", "1", {
          fromContactId: contacts[0]!.id,
          toContactId: contacts[1]!.id,
          reason: "Local action smoke validation only. Do not write.",
          suggestedIntro: "Local action smoke validation only.",
          evidence: { source: "smoke-actions-local" },
        })
      : null;
  assert(
    introductionValidation == null || introductionValidation.ok,
    `contact.introduction.recommend payload failed validation: ${introductionValidation?.errors.join(
      "; ",
    )}`,
  );

  const messageDraftValidation =
    contacts[0] != null
      ? registry.validatePayload("contact.message.draft", "1", {
          contactId: contacts[0].id,
          body: "Local action smoke validation only. Do not send.",
          reason: "Local action smoke validation only. Do not write.",
          channelHint: "smoke",
          evidence: { source: "smoke-actions-local" },
        })
      : null;
  assert(
    messageDraftValidation == null || messageDraftValidation.ok,
    `contact.message.draft payload failed validation: ${messageDraftValidation?.errors.join("; ")}`,
  );

  const aliases = listContactMergeAliases(db);
  const conversations = db.executeReadOnlySql(`
    SELECT c.id, COUNT(m.id) AS message_count
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.is_active = 1
      AND m.is_deleted = 0
    GROUP BY c.id
    ORDER BY MAX(m.sent_at) DESC
    LIMIT 1
  `) as ConversationRow[];
  const summaryDraftValidation =
    conversations[0] != null
      ? registry.validatePayload("conversation.summary.draft", "1", {
          conversationId: conversations[0].id,
          summary: "Local action smoke validation only. Do not write.",
          reason: "Local action smoke validation only. Do not write.",
          timeWindow: "recent",
          evidence: {
            source: "smoke-actions-local",
            messageCount: conversations[0].message_count,
          },
        })
      : null;
  assert(
    summaryDraftValidation == null || summaryDraftValidation.ok,
    `conversation.summary.draft payload failed validation: ${summaryDraftValidation?.errors.join(
      "; ",
    )}`,
  );
  const conversationFollowupValidation =
    conversations[0] != null
      ? registry.validatePayload("conversation.followup.recommend", "1", {
          conversationId: conversations[0].id,
          reason: "Local action smoke validation only. Do not write.",
          suggestedNextStep: "Local action smoke validation only.",
          evidence: {
            source: "smoke-actions-local",
            messageCount: conversations[0].message_count,
          },
        })
      : null;
  assert(
    conversationFollowupValidation == null || conversationFollowupValidation.ok,
    `conversation.followup.recommend payload failed validation: ${conversationFollowupValidation?.errors.join(
      "; ",
    )}`,
  );
  const recentActions = db.executeReadOnlySql(`
    SELECT action_type, status, approval_status, execution_status, queued_at
    FROM actions
    ORDER BY queued_at DESC
    LIMIT 5
  `);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        readonly: true,
        definitions: definitions.map((definition) => ({
          type: definition.type,
          version: definition.version,
          module: definition.module,
          sourcePath: definition.sourcePath,
          rebuildProjection: definition.postExecution.rebuildProjection,
        })),
        sampledContactCount: contacts.length,
        sampledContactsHaveNames: contacts.map((contact) => Boolean(contact.name)),
        sampledConversationCount: conversations.length,
        mergeAliasCount: aliases.length,
        recentActionCount: Array.isArray(recentActions) ? recentActions.length : 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db.close();
}
