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

function planContactMerges(db, input) {
  if (input.length === 0) {
    throw new Error("At least one contact merge is required.");
  }

  const aliasMap = new Map(
    db.listContactMergeAliases().map((row) => [row.contact_id, row.canonical_contact_id]),
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
  const [merge] = planContactMerges(db, [
    {
      primaryContactId: helpers.requiredStringPayload(payload, "primaryContactId", action),
      secondaryContactId: helpers.requiredStringPayload(payload, "secondaryContactId", action),
      reason: helpers.optionalStringPayload(payload, "reason", action),
    },
  ]);
  if (!merge) {
    throw new Error("Contact merge action did not produce a merge record.");
  }

  db.moveContactMemoriesToContact({
    fromContactId: merge.secondaryContactId,
    toContactId: merge.canonicalContactId,
  });
  const effect = db.recordActionEffect({
    actionId: action.id,
    effectType: "contact.merge.recorded",
    targetTable: "contacts",
    targetId: merge.canonicalContactId,
    payload: merge,
  });

  return {
    result: { merge },
    effects: [effect],
  };
}

module.exports = { execute };
