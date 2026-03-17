import type {
  SlackAuthTestResponse,
  SlackConversation,
  SlackMessage,
  SlackUser,
} from "./api/types.js";

export interface SlackConversationsResult {
  conversations: SlackConversation[];
  nextCursor?: string;
}

export interface SlackMessagesResult {
  messages: SlackMessage[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SlackUsersResult {
  users: SlackUser[];
  nextCursor?: string;
}

export interface SlackTransport {
  testAuth(): Promise<SlackAuthTestResponse>;
  listUsers(cursor?: string, limit?: number): Promise<SlackUsersResult>;
  listConversations(
    types: string,
    cursor?: string,
    limit?: number,
  ): Promise<SlackConversationsResult>;
  getConversationMembers(
    channel: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ members: string[]; nextCursor?: string }>;
  getHistory(
    channel: string,
    options?: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    },
  ): Promise<SlackMessagesResult>;
  getReplies(
    channel: string,
    threadTs: string,
    options?: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    },
  ): Promise<SlackMessagesResult>;
}
