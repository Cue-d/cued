function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const contactId = helpers.requiredStringPayload(payload, "contactId", action);
  if (!db.contactExists(contactId)) {
    throw new Error(`Contact not found: ${contactId}`);
  }

  const recommendation = {
    contactId,
    field: helpers.requiredStringPayload(payload, "field", action),
    value: helpers.requiredStringPayload(payload, "value", action),
    sourceKind: helpers.optionalStringPayload(payload, "sourceKind", action) ?? "local",
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.enrichment.recommended",
    targetTable: "contacts",
    targetId: contactId,
    payload: recommendation,
  });

  return {
    result: { recommendation },
    effects: [effect],
  };
}

module.exports = { execute };
