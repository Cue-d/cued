function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const conversationId = helpers.requiredStringPayload(payload, "conversationId", action);
  if (!db.conversationExists(conversationId)) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const draft = {
    conversationId,
    summary: helpers.requiredStringPayload(payload, "summary", action),
    reason: helpers.requiredStringPayload(payload, "reason", action),
    timeWindow: helpers.optionalStringPayload(payload, "timeWindow", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "conversation.summary.drafted",
    targetTable: "conversations",
    targetId: conversationId,
    payload: draft,
  });

  return {
    result: { draft },
    effects: [effect],
  };
}

module.exports = { execute };
