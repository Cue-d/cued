import { PAGINATION, SLACK_API_URLS } from "./constants.js";
import { newPostRequest } from "./request.js";
import type {
  SlackAuthTestResponse,
  SlackConversation,
  SlackConversationsHistoryResponse,
  SlackConversationsListResponse,
  SlackConversationsMembersResponse,
  SlackConversationsRepliesResponse,
  SlackCredentials,
  SlackMessage,
  SlackUser,
  SlackUsersListResponse,
} from "./types.js";

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

function normalizeCursor(cursor: string | undefined): string | undefined {
  return cursor && cursor.length > 0 ? cursor : undefined;
}

export class SlackClient {
  constructor(private readonly credentials: SlackCredentials) {}

  async testAuth(): Promise<SlackAuthTestResponse> {
    return newPostRequest(
      SLACK_API_URLS.authTest,
      this.credentials,
    ).doJSON<SlackAuthTestResponse>();
  }

  async listUsers(
    cursor?: string,
    limit: number = PAGINATION.defaultLimit,
  ): Promise<SlackUsersResult> {
    const response = await newPostRequest(SLACK_API_URLS.usersList, this.credentials)
      .withParams({
        cursor,
        limit,
      })
      .doJSON<SlackUsersListResponse>();

    return {
      users: response.members ?? [],
      nextCursor: normalizeCursor(response.response_metadata?.next_cursor),
    };
  }

  async listConversations(
    cursor?: string,
    limit: number = PAGINATION.defaultLimit,
  ): Promise<SlackConversationsResult> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsList, this.credentials)
      .withParams({
        types: "im,mpim,private_channel,public_channel",
        limit,
        cursor,
      })
      .doJSON<SlackConversationsListResponse>();

    return {
      conversations: response.channels ?? [],
      nextCursor: normalizeCursor(response.response_metadata?.next_cursor),
    };
  }

  async getConversationMembers(
    channel: string,
    cursor?: string,
    limit: number = PAGINATION.defaultLimit,
  ): Promise<{ members: string[]; nextCursor?: string }> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsMembers, this.credentials)
      .withParams({
        channel,
        limit,
        cursor,
      })
      .doJSON<SlackConversationsMembersResponse>();

    return {
      members: response.members ?? [],
      nextCursor: normalizeCursor(response.response_metadata?.next_cursor),
    };
  }

  async getHistory(
    channel: string,
    options: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    } = {},
  ): Promise<SlackMessagesResult> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsHistory, this.credentials)
      .withParams({
        channel,
        limit: options.limit ?? PAGINATION.defaultLimit,
        cursor: options.cursor,
        oldest: options.oldest,
      })
      .doJSON<SlackConversationsHistoryResponse>();

    return {
      messages: response.messages ?? [],
      hasMore: response.has_more ?? false,
      nextCursor: normalizeCursor(response.response_metadata?.next_cursor),
    };
  }

  async getReplies(
    channel: string,
    threadTs: string,
    options: {
      cursor?: string;
      oldest?: string;
      limit?: number;
    } = {},
  ): Promise<SlackMessagesResult> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsReplies, this.credentials)
      .withParams({
        channel,
        ts: threadTs,
        limit: options.limit ?? PAGINATION.defaultLimit,
        cursor: options.cursor,
        oldest: options.oldest,
      })
      .doJSON<SlackConversationsRepliesResponse>();

    return {
      messages: response.messages ?? [],
      hasMore: response.has_more ?? false,
      nextCursor: normalizeCursor(response.response_metadata?.next_cursor),
    };
  }
}
