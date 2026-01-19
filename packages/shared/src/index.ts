/**
 * @prm/shared - Shared utilities for PRM
 */

export { normalizePhone, getPhoneVariants, phonesMatch } from "./phone.js";

// Utility functions
export { getInitials } from "./utils/index.js";
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
  DraftRiskFlag,
  DraftLabel,
  DraftOption,
  MessageAttachment,
  DisplayMessage,
  ContactFormData,
} from "./types/actions.js";
