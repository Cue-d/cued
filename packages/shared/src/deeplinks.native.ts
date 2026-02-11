/**
 * Shared deep link URL builders for opening conversations/contacts in native apps.
 * Used by both Electron and mobile to ensure consistent deep link schemas.
 */

import { extractLinkedInThreadId } from "./linkedin";
import { PLATFORM_CONFIG, type ActionPlatform } from "./constants/platform";

// ── Types ─────────────────────────────────────────────────────────

export type DeeplinkResult =
  | { type: "available"; url: string }
  | { type: "disabled"; reason: string }
  | null;

export interface DeeplinkConversationContext {
  platformConversationId: string | null;
  conversationType: string | null;
  workspaceId?: string | null;
}

export interface DeeplinkContactContext {
  handles?: Array<{ handleType: string; handle: string; platform: string }>;
}

// ── URL Builders ──────────────────────────────────────────────────

/** Build a deep link URL for a single handle (no conversation context). */
export function buildHandleDeeplink(
  platform: string,
  handleType: string,
  handle: string,
): string | null {
  switch (platform) {
    case "imessage":
      return handleType === "phone" || handleType === "email"
        ? `imessage://${handle}`
        : null;
    case "gmail":
      return handleType === "email" ? `mailto:${handle}` : null;
    case "linkedin":
      return handleType === "linkedin_handle"
        ? `https://www.linkedin.com/in/${handle}`
        : null;
    default:
      return null;
  }
}

/**
 * Get a deep link for a platform action.
 * Tries conversation-level deep link first, then falls back to handle-level.
 */
export function getPlatformDeeplink(
  platform: string,
  conversation: DeeplinkConversationContext | null,
  contact: DeeplinkContactContext | null,
): DeeplinkResult {
  // Conversation-level deep links
  if (conversation) {
    switch (platform) {
      case "imessage":
        if (conversation.conversationType === "group") {
          return {
            type: "disabled",
            reason: "Deep linking isn't supported for iMessage group chats",
          };
        }
        break;
      case "gmail":
        if (conversation.platformConversationId) {
          return {
            type: "available",
            url: `https://mail.google.com/mail/u/0/#inbox/${conversation.platformConversationId}`,
          };
        }
        break;
      case "slack":
        if (
          conversation.platformConversationId &&
          conversation.workspaceId
        ) {
          return {
            type: "available",
            url: `slack://channel?team=${conversation.workspaceId}&id=${conversation.platformConversationId}`,
          };
        }
        return null;
      case "linkedin":
        if (conversation.platformConversationId) {
          const threadId = extractLinkedInThreadId(
            conversation.platformConversationId,
          );
          return {
            type: "available",
            url: `https://www.linkedin.com/messaging/thread/${threadId}`,
          };
        }
        break;
    }
  }

  // Fallback: handle-level deep link
  if (contact?.handles) {
    for (const h of contact.handles) {
      if (h.platform === platform) {
        const url = buildHandleDeeplink(h.platform, h.handleType, h.handle);
        if (url) return { type: "available", url };
      }
    }
  }

  return null;
}

/**
 * Get a deep link for a contact based on their handles (no conversation context).
 * Returns a DeeplinkResult with the resolved platform, or null.
 */
export function getContactDeeplink(
  handles:
    | Array<{ handleType: string; handle: string; platform: string }>
    | undefined,
): (DeeplinkResult & { platform?: string }) | null {
  if (!handles?.length) return null;

  for (const h of handles) {
    const url = buildHandleDeeplink(h.platform, h.handleType, h.handle);
    if (url) return { type: "available", url, platform: h.platform };
  }

  // Fallback: email handles regardless of platform
  const emailHandle = handles.find((h) => h.handleType === "email");
  if (emailHandle) {
    return {
      type: "available",
      url: `mailto:${emailHandle.handle}`,
      platform: "gmail",
    };
  }

  return null;
}

/**
 * Get the "Open {Platform}" label for a platform.
 * Returns null if the platform is not recognized.
 */
export function getOpenInAppLabel(platform: string): string | null {
  const config = PLATFORM_CONFIG[platform as ActionPlatform];
  return config ? `Open ${config.label}` : null;
}
