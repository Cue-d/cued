function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const contactId = helpers.requiredStringPayload(payload, "contactId", action);
  if (!db.contactExists(contactId)) {
    throw new Error(`Contact not found: ${contactId}`);
  }

  const draft = {
    contactId,
    body: helpers.requiredStringPayload(payload, "body", action),
    reason: helpers.requiredStringPayload(payload, "reason", action),
    channelHint: helpers.optionalStringPayload(payload, "channelHint", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.message.drafted",
    targetTable: "contacts",
    targetId: contactId,
    payload: draft,
  });

  return {
    result: { draft },
    effects: [effect],
  };
}

module.exports = { execute };
