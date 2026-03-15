import { COOKIE_NAMES, DEFAULT_X_LI_TRACK, USER_AGENT } from "./constants.js";
import { getConnections } from "./contacts.js";
import { getConversations, getConversationsBefore } from "./conversations.js";
import { linkedInEncode, newGetRequest } from "./request.js";
import { getReactors } from "./reactions.js";
import type {
  Connection,
  Conversation,
  Cookie,
  Message,
  MessagingParticipant,
  PagingMetadata,
} from "./types.js";

export interface ConversationsResult {
  conversations: Conversation[];
  metadata?: PagingMetadata;
  syncToken?: string;
  deletedConversationURNs?: string[];
}

export interface MessagesResult {
  messages: Message[];
  metadata?: PagingMetadata;
  prevCursor?: string | null;
}

export interface ConnectionsResult {
  connections: Connection[];
  metadata?: PagingMetadata;
  cursor?: string;
}

export interface LinkedInClientOptions {
  cookies?: Cookie[];
  userAgent?: string;
  xLiTrack?: string;
  pageInstance?: string;
}

export class LinkedInClient {
  private readonly _cookies: Cookie[];
  private readonly _userAgent: string;
  private readonly _xLiTrack: string;
  private readonly _pageInstance: string;
  private _userEntityURN: string | null = null;

  constructor(options: LinkedInClientOptions = {}) {
    this._cookies = options.cookies ?? [];
    this._userAgent = options.userAgent ?? USER_AGENT;
    this._xLiTrack = options.xLiTrack ?? DEFAULT_X_LI_TRACK;
    this._pageInstance = options.pageInstance ?? "urn:li:page:messaging_thread;";
  }

  get cookies(): Cookie[] {
    return this._cookies;
  }

  get userEntityURN(): string | null {
    return this._userEntityURN;
  }

  get userAgent(): string {
    return this._userAgent;
  }

  get xLiTrack(): string {
    return this._xLiTrack;
  }

  get pageInstance(): string {
    return this._pageInstance;
  }

  isAuthenticated(): boolean {
    return (
      this._cookies.some((cookie) => cookie.name === COOKIE_NAMES.authToken && cookie.value) &&
      this._cookies.some((cookie) => cookie.name === COOKIE_NAMES.sessionId && cookie.value)
    );
  }

  async fetchSelf(): Promise<string> {
    if (this._userEntityURN) {
      return this._userEntityURN;
    }

    const response = await newGetRequest("https://www.linkedin.com/voyager/api/me", this._cookies, {
      pageInstance: this._pageInstance,
      xLiTrack: this._xLiTrack,
      allowRedirects: false,
    })
      .withXLIHeaders()
      .doJSON<{
        data?: { plainId?: number };
        included?: Array<{ entityUrn?: string; $type?: string }>;
      }>();

    const miniProfile = response.included?.find(
      (item) => item.$type?.includes("MiniProfile") || item.entityUrn?.includes("fsd_profile"),
    );
    const urn = miniProfile?.entityUrn;
    if (urn) {
      const match = urn.match(/:([^:]+)$/);
      if (match?.[1]) {
        this._userEntityURN = `urn:li:fsd_profile:${match[1]}`;
        return this._userEntityURN;
      }
    }

    if (response.data?.plainId) {
      this._userEntityURN = `urn:li:fsd_profile:${response.data.plainId}`;
      return this._userEntityURN;
    }

    throw new Error("Could not determine user entity URN from /me response");
  }

  async getMailboxUrn(): Promise<string> {
    return linkedInEncode(await this.fetchSelf());
  }

  async getConversations(syncToken?: string): Promise<ConversationsResult> {
    return getConversations(this, syncToken);
  }

  async getConversationsBefore(timestamp: number): Promise<ConversationsResult> {
    return getConversationsBefore(this, timestamp);
  }

  async getMessages(conversationId: string): Promise<MessagesResult> {
    const { getMessages } = await import("./messages.js");
    return getMessages(this, conversationId);
  }

  async getMessagesWithPrevCursor(
    conversationId: string,
    prevCursor: string,
  ): Promise<MessagesResult> {
    const { getMessagesWithPrevCursor } = await import("./messages.js");
    return getMessagesWithPrevCursor(this, conversationId, prevCursor);
  }

  async getMessagesBefore(conversationId: string, timestamp: number): Promise<MessagesResult> {
    const { getMessagesBefore } = await import("./messages.js");
    return getMessagesBefore(this, conversationId, timestamp);
  }

  async getConnections(cursor?: string): Promise<ConnectionsResult> {
    return getConnections(this, cursor);
  }

  async getReactors(messageUrn: string, emoji: string): Promise<MessagingParticipant[]> {
    return getReactors(this, messageUrn, emoji);
  }
}
