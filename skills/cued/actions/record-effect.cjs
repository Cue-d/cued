function getRequiredString(payload, field, action) {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Action '${action.action_type}' payload field '${field}' must be a string.`);
  }
  return value;
}

function assertTargetExists(db, targetKind, id, label) {
  const exists = targetKind === "contact" ? db.contactExists(id) : db.conversationExists(id);
  if (!exists) {
    throw new Error(`${label} not found: ${id}`);
  }
}

function buildEffectPayload(payload, definition) {
  const effectPayload = {};
  for (const field of Object.keys(definition.payload.required)) {
    effectPayload[field] = payload[field];
  }
  for (const field of Object.keys(definition.payload.optional)) {
    effectPayload[field] =
      payload[field] === undefined || payload[field] === null
        ? (definition.effect.defaults[field] ?? null)
        : payload[field];
  }
  return effectPayload;
}

function execute({ action, definition, db, helpers }) {
  const effectDefinition = definition.effect;
  if (!effectDefinition) {
    throw new Error(`Action '${action.action_type}' is missing an effect definition.`);
  }
  const payload = helpers.parseActionPayloadObject(action);

  const targetId = getRequiredString(payload, effectDefinition.targetIdField, action);
  assertTargetExists(db, effectDefinition.targetExists, targetId, effectDefinition.targetIdField);
  for (const field of effectDefinition.requireExistingFields) {
    assertTargetExists(
      db,
      effectDefinition.targetExists,
      getRequiredString(payload, field, action),
      field,
    );
  }
  for (const [leftField, rightField] of effectDefinition.distinctFieldPairs) {
    if (
      getRequiredString(payload, leftField, action) ===
      getRequiredString(payload, rightField, action)
    ) {
      throw new Error(
        `Action '${action.action_type}' requires different ${leftField} and ${rightField}.`,
      );
    }
  }

  const effectPayload = buildEffectPayload(payload, definition);
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: effectDefinition.effectType,
    targetTable: effectDefinition.targetTable,
    targetId,
    payload: effectPayload,
  });

  return {
    result: { [effectDefinition.resultKey]: effectPayload },
    effects: [effect],
  };
}

module.exports = { execute };
