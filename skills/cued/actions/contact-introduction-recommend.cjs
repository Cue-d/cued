function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const fromContactId = helpers.requiredStringPayload(payload, "fromContactId", action);
  const toContactId = helpers.requiredStringPayload(payload, "toContactId", action);
  if (fromContactId === toContactId) {
    throw new Error("Introduction recommendation requires two different contacts.");
  }
  if (!db.contactExists(fromContactId)) {
    throw new Error(`From contact not found: ${fromContactId}`);
  }
  if (!db.contactExists(toContactId)) {
    throw new Error(`To contact not found: ${toContactId}`);
  }

  const recommendation = {
    fromContactId,
    toContactId,
    reason: helpers.requiredStringPayload(payload, "reason", action),
    suggestedIntro: helpers.optionalStringPayload(payload, "suggestedIntro", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.introduction.recommended",
    targetTable: "contacts",
    targetId: fromContactId,
    payload: recommendation,
  });

  return {
    result: { recommendation },
    effects: [effect],
  };
}

module.exports = { execute };
