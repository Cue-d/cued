import { describe, expect, it } from "vitest";
import {
  MERGE_CONFLICT_FIELD_LABELS,
  CONTACT_AUDIT_ACTION_LABELS,
  isRealContactName,
  getContactAuditActionLabel,
} from "../contact-merge";

describe("contact-merge utils", () => {
  it("exports conflict labels for merge fields", () => {
    expect(MERGE_CONFLICT_FIELD_LABELS.displayName).toBe("Name");
    expect(MERGE_CONFLICT_FIELD_LABELS.company).toBe("Company");
    expect(MERGE_CONFLICT_FIELD_LABELS.notes).toBe("Notes");
  });

  it("returns human label for known audit actions", () => {
    expect(getContactAuditActionLabel("merge")).toBe(
      CONTACT_AUDIT_ACTION_LABELS.merge,
    );
  });

  it("returns fallback for unknown audit actions", () => {
    expect(getContactAuditActionLabel("custom_action")).toBe("custom_action");
  });

  it("classifies obvious identifier names as non-real", () => {
    expect(isRealContactName("+15551234567")).toBe(false);
    expect(isRealContactName("U12345678")).toBe(false);
    expect(isRealContactName("urn:li:member:123")).toBe(false);
    expect(isRealContactName("person@example.com")).toBe(false);
  });

  it("classifies normal person names as real", () => {
    expect(isRealContactName("Jane Doe")).toBe(true);
    expect(isRealContactName("Alicia")).toBe(true);
  });
});
