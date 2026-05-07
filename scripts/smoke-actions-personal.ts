import { loadActionExecutor } from "../src/actions/executor-loader.js";
import { ActionDefinitionRegistry } from "../src/actions/registry.js";
import { openCuedDatabaseReadOnly } from "../src/db/database.js";

type FollowupCandidateRow = {
  contact_id: string;
  has_name: number;
  message_count: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
};

type EnrichmentCandidateRow = {
  contact_id: string;
  field: string;
  value: string;
  source_kind: string;
};

type IntroductionCandidateRow = {
  first_contact_id: string;
  second_contact_id: string;
  shared_conversation_count: number;
};

type ConversationSummaryCandidateRow = {
  conversation_id: string;
  message_count: number;
  last_message_at: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const registry = ActionDefinitionRegistry.load();
const definitions = registry.list();
for (const definition of definitions) {
  assert(
    loadActionExecutor(definition),
    `Missing executor for ${definition.type}@${definition.version}`,
  );
}

const db = openCuedDatabaseReadOnly();
try {
  const since = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const candidates = db.executeReadOnlySql(
    `
    WITH contact_message_stats AS (
      SELECT
        cp.contact_id,
        COUNT(m.id) AS message_count,
        MAX(CASE WHEN m.is_from_me = 0 THEN m.sent_at END) AS last_inbound_at,
        MAX(CASE WHEN m.is_from_me = 1 THEN m.sent_at END) AS last_outbound_at
      FROM conversation_participants cp
      JOIN messages m ON m.conversation_id = cp.conversation_id
      WHERE cp.is_self = 0
        AND cp.is_active = 1
        AND m.is_deleted = 0
        AND m.sent_at >= ${since}
      GROUP BY cp.contact_id
    )
    SELECT
      c.id AS contact_id,
      CASE WHEN c.name IS NULL OR c.name = '' THEN 0 ELSE 1 END AS has_name,
      s.message_count,
      s.last_inbound_at,
      s.last_outbound_at
    FROM contact_message_stats s
    JOIN contacts c ON c.id = s.contact_id
    WHERE c.archived = 0
      AND s.last_inbound_at IS NOT NULL
      AND (s.last_outbound_at IS NULL OR s.last_inbound_at >= s.last_outbound_at)
    ORDER BY s.last_inbound_at DESC
    LIMIT 5
  `,
  ) as FollowupCandidateRow[];

  const followupResults = candidates.map((candidate) =>
    registry.validatePayload("contact.followup.recommend", "1", {
      contactId: candidate.contact_id,
      reason: "Recent inbound message has no newer outbound reply.",
      suggestedMessage: "Following up on our last thread.",
      dueAt: Date.now(),
      evidence: {
        source: "smoke-actions-personal",
        messageCount: candidate.message_count,
        lastInboundAt: candidate.last_inbound_at,
        lastOutboundAt: candidate.last_outbound_at,
      },
    }),
  );
  for (const result of followupResults) {
    assert(result.ok, `Invalid follow-up payload: ${result.errors.join("; ")}`);
  }
  const draftResults = candidates.map((candidate) =>
    registry.validatePayload("contact.message.draft", "1", {
      contactId: candidate.contact_id,
      body: "Following up on our last thread.",
      reason: "Recent inbound message has no newer outbound reply.",
      channelHint: "local",
      evidence: {
        source: "smoke-actions-personal",
        messageCount: candidate.message_count,
        lastInboundAt: candidate.last_inbound_at,
        lastOutboundAt: candidate.last_outbound_at,
      },
      confidence: 60,
    }),
  );
  for (const result of draftResults) {
    assert(result.ok, `Invalid message draft payload: ${result.errors.join("; ")}`);
  }

  const enrichmentCandidates = db.executeReadOnlySql(`
    SELECT
      c.id AS contact_id,
      'profile_url' AS field,
      cs.profile_url AS value,
      cs.platform AS source_kind
    FROM contacts c
    JOIN contact_sources cs ON cs.contact_id = c.id
    WHERE c.archived = 0
      AND cs.profile_url IS NOT NULL
      AND cs.profile_url != ''
    ORDER BY cs.last_seen_at DESC
    LIMIT 5
  `) as EnrichmentCandidateRow[];
  const enrichmentResults = enrichmentCandidates.map((candidate) =>
    registry.validatePayload("contact.enrichment.recommend", "1", {
      contactId: candidate.contact_id,
      field: candidate.field,
      value: candidate.value,
      sourceKind: candidate.source_kind,
      evidence: { source: "smoke-actions-personal" },
      confidence: 80,
    }),
  );
  for (const result of enrichmentResults) {
    assert(result.ok, `Invalid enrichment payload: ${result.errors.join("; ")}`);
  }

  const introductionCandidates = db.executeReadOnlySql(`
    WITH active_pairs AS (
      SELECT
        cp1.contact_id AS first_contact_id,
        cp2.contact_id AS second_contact_id,
        COUNT(DISTINCT cp1.conversation_id) AS shared_conversation_count
      FROM conversation_participants cp1
      JOIN conversation_participants cp2
        ON cp2.conversation_id = cp1.conversation_id
       AND cp2.contact_id > cp1.contact_id
      JOIN contacts c1 ON c1.id = cp1.contact_id
      JOIN contacts c2 ON c2.id = cp2.contact_id
      WHERE cp1.is_self = 0
        AND cp2.is_self = 0
        AND cp1.is_active = 1
        AND cp2.is_active = 1
        AND c1.archived = 0
        AND c2.archived = 0
        AND c1.name IS NOT NULL
        AND c1.name != ''
        AND c2.name IS NOT NULL
        AND c2.name != ''
      GROUP BY cp1.contact_id, cp2.contact_id
      ORDER BY shared_conversation_count DESC
      LIMIT 3
    )
    SELECT first_contact_id, second_contact_id, shared_conversation_count
    FROM active_pairs
  `) as IntroductionCandidateRow[];
  const introductionResults = introductionCandidates.map((candidate) =>
    registry.validatePayload("contact.introduction.recommend", "1", {
      fromContactId: candidate.first_contact_id,
      toContactId: candidate.second_contact_id,
      reason: "They share conversation context in local Cued data.",
      suggestedIntro: "You may want to connect these two people around the shared thread.",
      evidence: {
        source: "smoke-actions-personal",
        sharedConversationCount: candidate.shared_conversation_count,
      },
      confidence: 50,
    }),
  );
  for (const result of introductionResults) {
    assert(result.ok, `Invalid introduction payload: ${result.errors.join("; ")}`);
  }

  const summaryCandidates = db.executeReadOnlySql(`
    SELECT
      c.id AS conversation_id,
      COUNT(m.id) AS message_count,
      MAX(m.sent_at) AS last_message_at
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.is_active = 1
      AND m.is_deleted = 0
    GROUP BY c.id
    HAVING message_count >= 2
    ORDER BY last_message_at DESC
    LIMIT 5
  `) as ConversationSummaryCandidateRow[];
  const summaryResults = summaryCandidates.map((candidate) =>
    registry.validatePayload("conversation.summary.draft", "1", {
      conversationId: candidate.conversation_id,
      summary: "Recent conversation summary draft placeholder.",
      reason: "Recent active conversation found in local Cued data.",
      timeWindow: "recent",
      evidence: {
        source: "smoke-actions-personal",
        messageCount: candidate.message_count,
        lastMessageAt: candidate.last_message_at,
      },
      confidence: 50,
    }),
  );
  for (const result of summaryResults) {
    assert(result.ok, `Invalid conversation summary payload: ${result.errors.join("; ")}`);
  }
  const conversationFollowupResults = summaryCandidates.map((candidate) =>
    registry.validatePayload("conversation.followup.recommend", "1", {
      conversationId: candidate.conversation_id,
      reason: "Recent active conversation may need a next step.",
      suggestedNextStep: "Review this conversation for follow-up.",
      evidence: {
        source: "smoke-actions-personal",
        messageCount: candidate.message_count,
        lastMessageAt: candidate.last_message_at,
      },
      confidence: 50,
    }),
  );
  for (const result of conversationFollowupResults) {
    assert(result.ok, `Invalid conversation follow-up payload: ${result.errors.join("; ")}`);
  }

  const recentActionRows = db.executeReadOnlySql(`
    SELECT action_type, status, approval_status, execution_status
    FROM actions
    ORDER BY queued_at DESC
    LIMIT 20
  `);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        readonly: true,
        loadedActionTypes: definitions.map((definition) => definition.type),
        followupCandidateCount: candidates.length,
        namedFollowupCandidateCount: candidates.filter((candidate) => candidate.has_name === 1)
          .length,
        messageDraftCandidateCount: candidates.length,
        enrichmentCandidateCount: enrichmentCandidates.length,
        introductionCandidateCount: introductionCandidates.length,
        conversationSummaryCandidateCount: summaryCandidates.length,
        conversationFollowupCandidateCount: summaryCandidates.length,
        recentActionCount: Array.isArray(recentActionRows) ? recentActionRows.length : 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db.close();
}
