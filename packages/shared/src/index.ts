/**
 * @cued/shared - Shared utilities for Cued
 */

export {
  normalizePhone,
  getPhoneVariants,
  phonesMatch,
  formatPhoneNumber,
} from "./phone.js";
export { normalizePublicAvatarUrl } from "./avatar.js";

// Utility functions
export { getInitials, truncate } from "./utils/index.js";
export {
  formatTime,
  formatRelativeTime,
  formatTimestamp,
  type FormatTimestampOptions,
} from "./utils/time.js";
export {
  MERGE_CONFLICT_FIELD_LABELS,
  CONTACT_AUDIT_ACTION_LABELS,
  isRealContactName,
  getContactAuditActionLabel,
} from "./utils/contact-merge.js";

// Platform constants
export {
  PLATFORM_CONFIG,
  getPlatformConfig,
  MULTI_WORKSPACE_PLATFORMS,
  type ActionPlatform,
  type PlatformConfigItem,
  type MultiWorkspacePlatform,
  type SyncPlatform,
} from "./constants/platform.js";

// Embedding constants
export {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  SIMILARITY_THRESHOLD,
  DISMISS_THRESHOLD,
  SIMILAR_LIMIT,
  MIN_HISTORY_FOR_SKIP,
  ACTION_SIMILARITY_WINDOW_MS,
} from "./constants/embeddings.js";

// Action queue types
export type {
  MessageAttachment,
  ReactionGroup,
  DisplayMessage,
  ContactFormData,
  EnrichedAction,
} from "./types/actions.js";

// Contact types
export type {
  HandleType,
  HandlePlatform,
  ContactHandle,
  ContactHandleInput,
} from "./types/contact.js";

// Action constants (legacy - use action registry for new code)
export {
  ACTION_TYPES,
  MESSAGE_ACTION_TYPES,
  CONTACT_ACTION_TYPES,
  isMessageActionType,
  isContactActionType,
  type ActionType,
} from "./constants/actions.js";

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
  type ResolveContactInput,
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
} from "./actions/registry.js";

// Platform adapter types (for message queue)
export type {
  SendResult,
  QueuedMessageAttachment,
  QueuedMessage,
  PlatformAdapter,
} from "./types/platform-adapter.js";

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
} from "./linkedin.js";

// Analytics events
export { ANALYTICS_EVENTS, type AnalyticsEvent } from "./analytics.js";
export type {
  SyncStartedProperties,
  SyncCompletedProperties,
  SyncFailedProperties,
  ActionEventProperties,
  AssistantMessageProperties,
  AssistantToolProperties,
  ContactViewedProperties,
  ContactEditedProperties,
  ContactMergedProperties,
} from "./analytics.js";

// Deep link utilities
export {
  buildHandleDeeplink,
  getPlatformDeeplink,
  getContactDeeplink,
  getOpenInAppLabel,
  type DeeplinkResult,
  type DeeplinkConversationContext,
  type DeeplinkContactContext,
} from "./deeplinks.js";
