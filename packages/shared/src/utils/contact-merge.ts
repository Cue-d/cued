export const MERGE_CONFLICT_FIELD_LABELS: Record<string, string> = {
  displayName: "Name",
  company: "Company",
  notes: "Notes",
};

export const CONTACT_AUDIT_ACTION_LABELS: Record<string, string> = {
  status_change: "Status changed",
  merge: "Contacts merged",
  unmerge: "Contact unmerged",
  keep_separate: "Marked keep-separate",
  handle_detach: "Handle detached",
  handle_move: "Handle moved",
  restore: "Restored",
};

/** Returns true if the display name looks like an actual person name (not a phone/ID/email). */
export function isRealContactName(displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return false;
  if (/^[\d+\-(). ]+$/.test(trimmed)) return false;
  if (/^[UW][A-Z0-9]{8,}$/i.test(trimmed)) return false;
  if (trimmed.startsWith("urn:li:")) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  return true;
}

export function getContactAuditActionLabel(action: string): string {
  return CONTACT_AUDIT_ACTION_LABELS[action] ?? action;
}
