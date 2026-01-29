/**
 * Centralized thresholds for contact resolution matching.
 */

/**
 * Core confidence tiers for name matching.
 * All other thresholds derive from these.
 */
export const CONFIDENCE = {
  /** Very high - auto-merge, deterministic match */
  HIGH: 0.95,
  /** Medium - suggest merge, high confidence */
  MEDIUM: 0.9,
  /** Low - needs review, triggers LLM analysis */
  LOW: 0.6,
  /** Cap for rejected matches (e.g., same family, different person) */
  REJECTION_CAP: 0.4,
} as const;

/**
 * Jaro-Winkler algorithm config.
 */
export const JARO_WINKLER = {
  SCALING_FACTOR: 0.1,
} as const;

/**
 * LLM matching config.
 */
export const LLM = {
  /** Min LLM confidence to create action card */
  CONFIDENCE_THRESHOLD: 0.7,
  MAX_RETRIES: 2,
} as const;

// === Backwards-compatible exports ===

export const NAME_MATCH_THRESHOLDS = {
  AUTO_MERGE: CONFIDENCE.HIGH,
  SUGGEST_MERGE: CONFIDENCE.MEDIUM,
  MINIMUM: CONFIDENCE.MEDIUM,
} as const;

export const LLM_CONFIDENCE_THRESHOLD = LLM.CONFIDENCE_THRESHOLD;
