/**
 * Embedding constants for action intelligence.
 * Used for vector similarity search to skip LLM analysis on historically dismissed patterns.
 */

/** OpenAI embedding model used for message embeddings */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Dimensions of the embedding vectors */
export const EMBEDDING_DIMENSIONS = 1536;

/** Minimum cosine similarity score to consider two messages "similar" */
export const SIMILARITY_THRESHOLD = 0.75;

/** Dismiss rate threshold (80%) - if similar messages dismissed at this rate, skip LLM */
export const DISMISS_THRESHOLD = 0.8;

/** Maximum number of similar messages to check for dismiss rate calculation */
export const SIMILAR_LIMIT = 10;

/** Minimum number of resolved actions (completed + discarded) required before skip logic activates */
export const MIN_HISTORY_FOR_SKIP = 3;

/** Rolling window in milliseconds for action similarity search (90 days) */
export const ACTION_SIMILARITY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
