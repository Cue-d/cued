/**
 * Shared deep link URL builders for opening conversations/contacts in native apps.
 * Used by both Electron and mobile to ensure consistent deep link schemas.
 */

import { extractLinkedInThreadId } from "./linkedin";
import { PLATFORM_CONFIG, type ActionPlatform } from "./constants/platform";
import { createDeeplinkUtilities } from "./deeplinks-core";

export type {
  DeeplinkResult,
  DeeplinkConversationContext,
  DeeplinkContactContext,
} from "./deeplinks-core";

const deeplinkUtilities = createDeeplinkUtilities({
  extractLinkedInThreadId,
  getPlatformLabel: (platform) =>
    PLATFORM_CONFIG[platform as ActionPlatform]?.label,
});

export const {
  buildHandleDeeplink,
  getPlatformDeeplink,
  getContactDeeplink,
  getOpenInAppLabel,
} = deeplinkUtilities;
