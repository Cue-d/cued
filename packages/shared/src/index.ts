/**
 * @prm/shared - Shared utilities for PRM
 */

export {
  normalizePhone,
  getPhoneVariants,
  phonesMatch,
  formatPhoneNumber,
} from "./phone.js";

// Utility functions
export { getInitials, truncate } from "./utils/index.js";
export {
  formatTime,
  formatRelativeTime,
  formatTimestamp,
  type FormatTimestampOptions,
  type FormatRelativeTimeOptions,
} from "./utils/time.js";

// Platform constants
export {
  PLATFORM_CONFIG,
  MULTI_WORKSPACE_PLATFORMS,
  getPlatformConfig,
  type ActionPlatform,
  type SyncPlatform,
  type MultiWorkspacePlatform,
  type PlatformConfigItem,
} from "./constants/platform.js";

// Action queue types
export type {
  MessageAttachment,
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

// Action constants
export {
  ACTION_TYPES,
  MESSAGE_ACTION_TYPES,
  CONTACT_ACTION_TYPES,
  isMessageActionType,
  isContactActionType,
  type ActionType,
} from "./constants/actions.js";

// Platform adapter types (for message queue)
export type {
  SendResult,
  QueuedMessage,
  PlatformAdapter,
} from "./types/platform-adapter.js";

// LinkedIn URN and handle utilities
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
} from "./linkedin.js";
