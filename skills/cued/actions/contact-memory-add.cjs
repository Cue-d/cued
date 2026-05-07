function execute({ action, db, executedBy, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const memory = db.addContactMemory({
    contactId: helpers.requiredStringPayload(payload, "contactId", action),
    body: helpers.requiredStringPayload(payload, "body", action),
    sourceKind: helpers.optionalStringPayload(payload, "sourceKind", action) ?? "agent",
    evidence: helpers.optionalObjectPayload(payload, "evidence", action),
    confidence: helpers.optionalNumberPayload(payload, "confidence", action),
    supersedesMemoryId: helpers.optionalStringPayload(payload, "supersedesMemoryId", action),
    createdBy: executedBy,
  });
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact_memory.added",
    targetTable: "contact_memories",
    targetId: memory.id,
    payload: { memoryId: memory.id, contactId: memory.contact_id },
  });

  return {
    result: { memory },
    effects: [effect],
  };
}

module.exports = { execute };
