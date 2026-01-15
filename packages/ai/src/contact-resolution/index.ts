/**
 * Contact resolution utilities for matching and merging contacts.
 * Phase 6: Cross-platform contact matching.
 */

export {
  normalizeEmail,
  getEmailVariants,
  emailsMatch,
  phonesMatch,
  findHandleMatch,
  normalizePhone,
  getPhoneVariants,
} from "./deterministic";

export {
  normalizeName,
  jaroWinklerSimilarity,
  nameSimilarity,
  namesMatch,
  getNameMatchResult,
  NAME_MATCH_THRESHOLDS,
  type NameMatchResult,
} from "./fuzzy-name";
