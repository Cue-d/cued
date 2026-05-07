function resolveCanonicalContactId(contactId, aliasMap) {
  const seen = new Set();
  let current = contactId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliasMap.get(current);
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  throw new Error(`Contact merge alias cycle detected at ${current}`);
}

function parseMergeEffectPayload(payloadJson) {
  if (!payloadJson) {
    return null;
  }
  const payload = JSON.parse(payloadJson);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  if (
    typeof payload.secondaryContactId !== "string" ||
    typeof payload.canonicalContactId !== "string"
  ) {
    return null;
  }
  return {
    contact_id: payload.secondaryContactId,
    canonical_contact_id: payload.canonicalContactId,
  };
}

function listContactMergeAliases(db) {
  return db
    .listActiveActionEffects({
      actionType: "contact.merge",
      effectType: "contact.merge.recorded",
    })
    .map((effect) => parseMergeEffectPayload(effect.payload_json))
    .filter((alias) => alias !== null);
}

function planContactMerges(db, input, randomUUID) {
  if (input.length === 0) {
    throw new Error("At least one contact merge is required.");
  }

  const aliasMap = new Map(
    listContactMergeAliases(db).map((row) => [row.contact_id, row.canonical_contact_id]),
  );
  const planned = [];
  for (const merge of input) {
    const primaryContactId = merge.primaryContactId.trim();
    const secondaryContactId = merge.secondaryContactId.trim();
    if (!primaryContactId || !secondaryContactId) {
      throw new Error("Primary and secondary contact ids are required.");
    }
    if (primaryContactId === secondaryContactId) {
      throw new Error("Cannot merge a contact into itself");
    }
    if (!db.contactExists(primaryContactId)) {
      throw new Error(`Primary contact not found: ${primaryContactId}`);
    }
    if (!db.contactExists(secondaryContactId)) {
      throw new Error(`Secondary contact not found: ${secondaryContactId}`);
    }

    const canonicalPrimary = resolveCanonicalContactId(primaryContactId, aliasMap);
    const canonicalSecondary = resolveCanonicalContactId(secondaryContactId, aliasMap);
    if (canonicalPrimary === canonicalSecondary) {
      throw new Error(
        `Contacts already resolve to the same canonical contact: ${canonicalPrimary}`,
      );
    }

    aliasMap.set(canonicalSecondary, canonicalPrimary);
    resolveCanonicalContactId(canonicalSecondary, aliasMap);
    planned.push({
      decisionId: randomUUID(),
      primaryContactId: canonicalPrimary,
      secondaryContactId: canonicalSecondary,
      canonicalContactId: canonicalPrimary,
      reason: merge.reason ?? null,
    });
  }
  return planned;
}

function execute({ action, db, helpers }) {
  const payload = helpers.parseActionPayloadObject(action);
  const [decision] = planContactMerges(
    db,
    [
      {
        primaryContactId: helpers.requiredStringPayload(payload, "primaryContactId", action),
        secondaryContactId: helpers.requiredStringPayload(payload, "secondaryContactId", action),
        reason: helpers.optionalStringPayload(payload, "reason", action),
      },
    ],
    helpers.randomUUID,
  );
  if (!decision) {
    throw new Error("Contact merge action did not produce a merge decision.");
  }

  db.moveContactMemoriesToContact({
    fromContactId: decision.secondaryContactId,
    toContactId: decision.canonicalContactId,
  });
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.merge.recorded",
    targetTable: "contacts",
    targetId: decision.canonicalContactId,
    payload: decision,
  });

  return {
    result: { decision },
    effects: [effect],
  };
}

module.exports = { execute };
