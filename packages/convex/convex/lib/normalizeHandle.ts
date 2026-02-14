import { normalizeEmail } from "@cued/ai";
import {
  normalizeLinkedInHandle,
  normalizeMemberURN,
  normalizePhone,
} from "@cued/shared";

/**
 * Normalize a handle value based on its type.
 * Shared by contact mutations and deduplication logic.
 */
export function normalizeHandleValue(
  handleType: string,
  handle: string,
): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";

  switch (handleType) {
    case "email":
      return normalizeEmail(trimmed) || trimmed.toLowerCase();
    case "phone":
      return normalizePhone(trimmed);
    case "linkedin_urn":
      return normalizeMemberURN(trimmed).toLowerCase();
    case "urn":
      return trimmed.toLowerCase();
    case "linkedin_handle":
      return normalizeLinkedInHandle(trimmed) || trimmed.toLowerCase();
    case "twitter_handle":
      return trimmed.toLowerCase().replace(/^@/, "");
    case "signal_id":
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}
