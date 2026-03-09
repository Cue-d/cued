import { PAGINATION, SLACK_API_URLS } from "./constants.js";
import { newPostRequest } from "./request.js";
import type {
  SlackAuthTestResponse,
  SlackConversation,
  SlackConversationsHistoryResponse,
  SlackConversationsListResponse,
  SlackConversationsMembersResponse,
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

export class SlackClient {
  constructor(private readonly credentials: SlackCredentials) {}

  async testAuth(): Promise<SlackAuthTestResponse> {
    return newPostRequest(SLACK_API_URLS.authTest, this.credentials)
      .doJSON<SlackAuthTestResponse>();
  }

  async listUsers(cursor?: string): Promise<SlackUsersResult> {
    const response = await newPostRequest(SLACK_API_URLS.usersList, this.credentials)
      .withParams({
        cursor,
        limit: PAGINATION.defaultLimit,
      })
      .doJSON<SlackUsersListResponse>();

    return {
      users: response.members ?? [],
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async listConversations(cursor?: string): Promise<SlackConversationsResult> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsList, this.credentials)
      .withParams({
        types: "im,mpim,private_channel,public_channel",
        exclude_archived: true,
        limit: PAGINATION.defaultLimit,
        cursor,
      })
      .doJSON<SlackConversationsListResponse>();

    return {
      conversations: response.channels ?? [],
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async getConversationMembers(channel: string, cursor?: string): Promise<{ members: string[]; nextCursor?: string }> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsMembers, this.credentials)
      .withParams({
        channel,
        limit: PAGINATION.defaultLimit,
        cursor,
      })
      .doJSON<SlackConversationsMembersResponse>();

    return {
      members: response.members ?? [],
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async getHistory(
    channel: string,
    options: {
      cursor?: string;
      oldest?: string;
    } = {},
  ): Promise<SlackMessagesResult> {
    const response = await newPostRequest(SLACK_API_URLS.conversationsHistory, this.credentials)
      .withParams({
        channel,
        limit: PAGINATION.defaultLimit,
        cursor: options.cursor,
        oldest: options.oldest,
      })
      .doJSON<SlackConversationsHistoryResponse>();

    return {
      messages: response.messages ?? [],
      hasMore: response.has_more ?? false,
      nextCursor: response.response_metadata?.next_cursor,
    };
  }
}
