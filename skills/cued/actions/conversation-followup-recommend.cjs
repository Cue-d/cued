function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const conversationId = helpers.requiredStringPayload(payload, "conversationId", action);
  if (!db.conversationExists(conversationId)) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const recommendation = {
    conversationId,
    reason: helpers.requiredStringPayload(payload, "reason", action),
    suggestedNextStep: helpers.optionalStringPayload(payload, "suggestedNextStep", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "conversation.followup.recommended",
    targetTable: "conversations",
    targetId: conversationId,
    payload: recommendation,
  });

  return {
    result: { recommendation },
    effects: [effect],
  };
}

module.exports = { execute };
