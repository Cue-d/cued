/**
 * React Native entrypoint for @cued/shared.
 * Uses extensionless imports so Metro can resolve TS source files in monorepo builds.
 */

export {
  normalizePhone,
  getPhoneVariants,
  phonesMatch,
  formatPhoneNumber,
} from "./phone";

// Utility functions
export { getInitials, truncate } from "./utils/index";
export {
  formatTime,
  formatRelativeTime,
  formatTimestamp,
  type FormatTimestampOptions,
} from "./utils/time";

// Platform constants
export {
  PLATFORM_CONFIG,
  getPlatformConfig,
  MULTI_WORKSPACE_PLATFORMS,
  type ActionPlatform,
  type PlatformConfigItem,
  type MultiWorkspacePlatform,
  type SyncPlatform,
} from "./constants/platform";

// Embedding constants
export {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  SIMILARITY_THRESHOLD,
  DISMISS_THRESHOLD,
  SIMILAR_LIMIT,
  MIN_HISTORY_FOR_SKIP,
  ACTION_SIMILARITY_WINDOW_MS,
} from "./constants/embeddings";

// Action queue types
export type {
  MessageAttachment,
  DisplayMessage,
  ContactFormData,
  EnrichedAction,
} from "./types/actions";

// Contact types
export type {
  HandleType,
  HandlePlatform,
  ContactHandle,
  ContactHandleInput,
} from "./types/contact";

// Action constants (legacy - use action registry for new code)
export {
  ACTION_TYPES,
  MESSAGE_ACTION_TYPES,
  CONTACT_ACTION_TYPES,
  isMessageActionType,
  isContactActionType,
  type ActionType,
} from "./constants/actions";

// Action Registry (preferred)
export {
  // Types
  type ActionIcon,
  type SwipeLabels,
  type ActionMetadata,
  type ValidationContext,
  type ActionDefinition,
  type ActionRegistryType,
  type RegisteredActionType,
  // Input types
  type MessageResponseInput,
  type NewConnectionInput,
  type ResolveContactInput,
  type EODContactInput,
  // Registry
  ACTION_REGISTRY,
  // Helpers
  getActionMetadata,
  getActionDefinition,
  isMessageAction,
  isContactAction,
  getActionTypesByCategory,
  getAllActionTypes,
  getSwipeLabels,
  hasResponseInput,
  hasContactForm,
} from "./actions/registry";

// Platform adapter types (for message queue)
export type {
  SendResult,
  QueuedMessage,
  PlatformAdapter,
} from "./types/platform-adapter.native";

// LinkedIn utilities
export {
  extractIdFromURN,
  normalizeConversationURN,
  normalizeMemberURN,
  isLinkedInURN,
  isConversationURN,
  isMemberURN,
  urnIdsMatch,
  isValidLinkedInHandle,
  normalizeLinkedInHandle,
  extractLinkedInThreadId,
} from "./linkedin";

// Deep link utilities
export {
  buildHandleDeeplink,
  getPlatformDeeplink,
  getContactDeeplink,
  getOpenInAppLabel,
  type DeeplinkResult,
  type DeeplinkConversationContext,
  type DeeplinkContactContext,
} from "./deeplinks.native";
