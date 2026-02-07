export type {
  Tool,
  ToolContext,
  ToolExecutionOptions,
  ToolResult,
} from "./types";
export { getErrorMessage } from "./types";

export { gateway, MODEL } from "./gateway";

export {
  searchMessagesTool,
  searchContactsTool,
  createActionTool,
  getConversationsTool,
  searchActionsTool,
  // Centralized tool registry
  createChatTools,
  createToolResult,
  type ToolConvexClient,
  type ConvexApi,
} from "./tools";

export {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  type MentionedContact,
  type MentionedContactHandle,
} from "./prompts/system";

export {
  ActionSuggestionSchema,
  generateAction,
  generateActionWithRetry,
  type ActionSuggestion,
  type ContactInfo,
  type ActionMessage,
  type GenerateActionInput,
  type RecentAction,
} from "./actions";

export {
  shouldSkipLlmAnalysis,
  isShortCode,
  isOtpMessage,
  isDeliveryNotification,
  isAccountSecuritySpam,
  hasUnsubscribe,
  isCarrierNotification,
  isUrgencySpam,
  isPromotional,
  isBankAlert,
  calculatePriority,
  calculateTimePriority,
  calculateContactBoost,
  calculateGroupPenalty,
  type FilterResult,
  type FilterInput,
  type SkipReason,
  type ContactPriorityInfo,
  type CalculatePriorityInput,
} from "./filters";

// Embedding utilities for action intelligence
export {
  buildEmbeddingInput,
  embedText,
  embedTexts,
  type MessageContext,
  type EmbeddingMetadata,
} from "./embeddings";

// Task 6.0a/6.0b: Contact resolution utilities
export {
  normalizeEmail,
  getEmailVariants,
  emailsMatch,
  phonesMatch,
  findHandleMatch,
  normalizePhone,
  getPhoneVariants,
  normalizeName,
  jaroWinklerSimilarity,
  nameSimilarity,
  namesMatch,
  getNameMatchResult,
  NAME_MATCH_THRESHOLDS,
  type NameMatchResult,
  // LLM-based fuzzy match decision
  decideFuzzyMatch,
  decideFuzzyMatchWithRetry,
  FuzzyMatchDecisionSchema,
  LLM_CONFIDENCE_THRESHOLD,
  type ContactMatchInput,
  type FuzzyMatchDecision,
  type TypedHandle,
  type MessageSnippet,
} from "./contact-resolution";
