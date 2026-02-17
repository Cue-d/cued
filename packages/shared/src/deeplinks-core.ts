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

interface DeeplinkDependencies {
  extractLinkedInThreadId: (conversationId: string) => string;
  getPlatformLabel: (platform: string) => string | undefined;
}

interface DeeplinkUtilities {
  buildHandleDeeplink: (
    platform: string,
    handleType: string,
    handle: string,
  ) => string | null;
  getPlatformDeeplink: (
    platform: string,
    conversation: DeeplinkConversationContext | null,
    contact: DeeplinkContactContext | null,
  ) => DeeplinkResult;
  getContactDeeplink: (
    handles:
      | Array<{ handleType: string; handle: string; platform: string }>
      | undefined,
  ) => (DeeplinkResult & { platform?: string }) | null;
  getOpenInAppLabel: (platform: string) => string | null;
}

export function createDeeplinkUtilities({
  extractLinkedInThreadId,
  getPlatformLabel,
}: DeeplinkDependencies): DeeplinkUtilities {
  function buildHandleDeeplink(
    platform: string,
    handleType: string,
    handle: string,
  ): string | null {
    switch (platform) {
      case "imessage":
        return handleType === "phone" || handleType === "email"
          ? `imessage://${handle}`
          : null;
      case "linkedin":
        return handleType === "linkedin_handle"
          ? `https://www.linkedin.com/in/${handle}`
          : null;
      case "twitter":
        return handleType === "twitter_handle"
          ? `https://x.com/${handle}`
          : null;
      default:
        return null;
    }
  }

  function getPlatformDeeplink(
    platform: string,
    conversation: DeeplinkConversationContext | null,
    contact: DeeplinkContactContext | null,
  ): DeeplinkResult {
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
        case "slack":
          if (conversation.platformConversationId && conversation.workspaceId) {
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

  function getContactDeeplink(
    handles:
      | Array<{ handleType: string; handle: string; platform: string }>
      | undefined,
  ): (DeeplinkResult & { platform?: string }) | null {
    if (!handles?.length) return null;

    for (const h of handles) {
      const url = buildHandleDeeplink(h.platform, h.handleType, h.handle);
      if (url) return { type: "available", url, platform: h.platform };
    }

    const emailHandle = handles.find((h) => h.handleType === "email");
    if (emailHandle) {
      return {
        type: "available",
        url: `mailto:${emailHandle.handle}`,
        platform: emailHandle.platform,
      };
    }

    return null;
  }

  function getOpenInAppLabel(platform: string): string | null {
    const label = getPlatformLabel(platform);
    return label ? `Open ${label}` : null;
  }

  return {
    buildHandleDeeplink,
    getPlatformDeeplink,
    getContactDeeplink,
    getOpenInAppLabel,
  };
}
