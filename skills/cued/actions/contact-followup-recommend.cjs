function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const contactId = helpers.requiredStringPayload(payload, "contactId", action);
  if (!db.contactExists(contactId)) {
    throw new Error(`Contact not found: ${contactId}`);
  }

  const recommendation = {
    contactId,
    reason: helpers.requiredStringPayload(payload, "reason", action),
    suggestedMessage: helpers.optionalStringPayload(payload, "suggestedMessage", action),
    dueAt: helpers.optionalNumberPayload(payload, "dueAt", action),
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
  };
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.followup.recommended",
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
