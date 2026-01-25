export type {
  Tool,
  ToolContext,
  ToolExecutionOptions,
  ToolResult,
} from "./types";
export { getErrorMessage } from "./types";

export { openai, DEFAULT_MODEL, FAST_MODEL } from "./openai";

export {
  searchMessagesTool,
  searchContactsTool,
  createActionTool,
  getConversationsTool,
  searchMemoriesTool,
  searchActionsTool,
  // Centralized tool registry
  createChatTools,
  createToolResult,
  type ToolConvexClient,
  type ConvexApi,
} from "./tools";

export {
  createMem0Provider,
  addContactMemories,
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  fetchContactMemories,
  type AddMemoriesResult,
  type ConversationMessage,
  type ContactMemoryItem,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "./mem0";

export {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  type MentionedContact,
  type MentionedContactHandle,
} from "./prompts/system";
export {
  CUSTOM_FACT_EXTRACTION_PROMPT,
  CUSTOM_UPDATE_MEMORY_PROMPT,
  buildMemoryInstructions,
} from "./prompts/memory";

export {
  ActionSuggestionSchema,
  generateAction,
  generateActionWithRetry,
  type ActionSuggestion,
  type ContactInfo,
  type ContactMemory,
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
} from "./contact-resolution";
