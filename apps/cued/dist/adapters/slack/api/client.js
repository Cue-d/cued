import { PAGINATION, SLACK_API_URLS } from "./constants.js";
import { newPostRequest } from "./request.js";
export class SlackClient {
    credentials;
    constructor(credentials) {
        this.credentials = credentials;
    }
    async testAuth() {
        return newPostRequest(SLACK_API_URLS.authTest, this.credentials)
            .doJSON();
    }
    async listUsers(cursor) {
        const response = await newPostRequest(SLACK_API_URLS.usersList, this.credentials)
            .withParams({
            cursor,
            limit: PAGINATION.defaultLimit,
        })
            .doJSON();
        return {
            users: response.members ?? [],
            nextCursor: response.response_metadata?.next_cursor,
        };
    }
    async listConversations(cursor) {
        const response = await newPostRequest(SLACK_API_URLS.conversationsList, this.credentials)
            .withParams({
            types: "im,mpim,private_channel,public_channel",
            exclude_archived: true,
            limit: PAGINATION.defaultLimit,
            cursor,
        })
            .doJSON();
        return {
            conversations: response.channels ?? [],
            nextCursor: response.response_metadata?.next_cursor,
        };
    }
    async getConversationMembers(channel, cursor) {
        const response = await newPostRequest(SLACK_API_URLS.conversationsMembers, this.credentials)
            .withParams({
            channel,
            limit: PAGINATION.defaultLimit,
            cursor,
        })
            .doJSON();
        return {
            members: response.members ?? [],
            nextCursor: response.response_metadata?.next_cursor,
        };
    }
    async getHistory(channel, options = {}) {
        const response = await newPostRequest(SLACK_API_URLS.conversationsHistory, this.credentials)
            .withParams({
            channel,
            limit: PAGINATION.defaultLimit,
            cursor: options.cursor,
            oldest: options.oldest,
        })
            .doJSON();
        return {
            messages: response.messages ?? [],
            hasMore: response.has_more ?? false,
            nextCursor: response.response_metadata?.next_cursor,
        };
    }
}
//# sourceMappingURL=client.js.map