export const SLACK_API_BASE = "https://slack.com/api";
export const SLACK_API_URLS = {
    authTest: `${SLACK_API_BASE}/auth.test`,
    usersList: `${SLACK_API_BASE}/users.list`,
    conversationsList: `${SLACK_API_BASE}/conversations.list`,
    conversationsHistory: `${SLACK_API_BASE}/conversations.history`,
    conversationsMembers: `${SLACK_API_BASE}/conversations.members`,
};
export const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
};
export const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 1000,
    authErrorStatusCodes: [401, 403],
    retryableStatusCodes: [429, 500, 502, 503, 504],
    tokenExpiredErrors: ["token_expired", "invalid_auth", "not_authed", "account_inactive"],
};
export const PAGINATION = {
    defaultLimit: 100,
};
//# sourceMappingURL=constants.js.map