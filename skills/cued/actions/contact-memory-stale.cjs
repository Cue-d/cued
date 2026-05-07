function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const memory = db.markContactMemoryStale(
    helpers.requiredStringPayload(payload, "memoryId", action),
  );
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact_memory.marked_stale",
    targetTable: "contact_memories",
    targetId: memory?.id ?? null,
    payload: { memoryId: memory?.id, contactId: memory?.contact_id },
  });

  return {
    result: { memory },
    effects: [effect],
  };
}

module.exports = { execute };
