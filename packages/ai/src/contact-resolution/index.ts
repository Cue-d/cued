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
  type NameMatchResult,
} from "./fuzzy-name";

export {
  decideFuzzyMatch,
  decideFuzzyMatchWithRetry,
  FuzzyMatchDecisionSchema,
  type ContactMatchInput,
  type FuzzyMatchDecision,
} from "./llm-match";

export {
  CONFIDENCE,
  JARO_WINKLER,
  LLM,
  NAME_MATCH_THRESHOLDS,
  LLM_CONFIDENCE_THRESHOLD,
} from "./thresholds";
