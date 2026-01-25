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
} from "./utils/time.js";

// Platform constants
export {
  PLATFORM_CONFIG,
  getPlatformConfig,
  type ActionPlatform,
  type PlatformConfigItem,
} from "./constants/platform.js";

// Action queue types
export type {
  MessageAttachment,
  DisplayMessage,
  ContactFormData,
} from "./types/actions.js";

// Platform adapter types (for message queue)
export type {
  SendResult,
  QueuedMessage,
  PlatformAdapter,
} from "./types/platform-adapter.js";

// LinkedIn URN utilities
export {
  extractIdFromURN,
  normalizeConversationURN,
  normalizeMemberURN,
  isLinkedInURN,
  isConversationURN,
  isMemberURN,
  urnIdsMatch,
} from "./linkedin.js";
