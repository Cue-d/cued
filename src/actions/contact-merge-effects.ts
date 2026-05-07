import type { CuedDatabase } from "../db/database.js";

export interface ContactMergeAlias {
  contact_id: string;
  canonical_contact_id: string;
}

function parseMergeEffectPayload(payloadJson: string | null): ContactMergeAlias | null {
  if (!payloadJson) {
    return null;
  }
  const payload = JSON.parse(payloadJson) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  if (typeof row.secondaryContactId !== "string" || typeof row.canonicalContactId !== "string") {
    return null;
  }
  return {
    contact_id: row.secondaryContactId,
    canonical_contact_id: row.canonicalContactId,
  };
}

export function listContactMergeAliases(db: CuedDatabase): ContactMergeAlias[] {
  return db
    .listActiveActionEffects({
      actionType: "contact.merge",
      effectType: "contact.merge.recorded",
    })
    .map((effect) => parseMergeEffectPayload(effect.payload_json))
    .filter((alias): alias is ContactMergeAlias => alias !== null);
}
