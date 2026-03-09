import { DEFAULT_HEADERS, RETRY_CONFIG, SLACK_API_BASE } from "./constants.js";
export class SlackAuthError extends Error {
    slackError;
    constructor(message, slackError) {
        super(message);
        this.slackError = slackError;
        this.name = "SlackAuthError";
    }
}
export class SlackRequestError extends Error {
    statusCode;
    slackError;
    response;
    constructor(message, statusCode, slackError, response) {
        super(message);
        this.statusCode = statusCode;
        this.slackError = slackError;
        this.response = response;
        this.name = "SlackRequestError";
    }
}
class SlackRequest {
    url;
    credentials;
    headers;
    formData = new Map();
    constructor(url, credentials) {
        this.url = url;
        this.credentials = credentials;
        this.headers = {
            ...DEFAULT_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `d=${credentials.cookie}`,
        };
    }
    withParams(params) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
                this.formData.set(key, String(value));
            }
        }
        return this;
    }
    buildBody() {
        const params = new URLSearchParams();
        params.set("token", this.credentials.token);
        for (const [key, value] of this.formData) {
            params.set(key, value);
        }
        return params.toString();
    }
    async doJSON() {
        let lastError = null;
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt += 1) {
            try {
                const response = await fetch(this.url, {
                    method: "POST",
                    headers: this.headers,
                    body: this.buildBody(),
                });
                if (RETRY_CONFIG.authErrorStatusCodes.includes(response.status)) {
                    throw new SlackAuthError(`Authentication failed: ${response.status} ${response.statusText}`, "http_auth_error");
                }
                if (RETRY_CONFIG.retryableStatusCodes.includes(response.status)) {
                    if (attempt < RETRY_CONFIG.maxRetries) {
                        await sleep(RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt));
                        continue;
                    }
                    throw new SlackRequestError(`Slack request failed: ${response.status}`, response.status);
                }
                const text = await response.text();
                const data = JSON.parse(text);
                if (data.ok === false) {
                    const error = data.error ?? "unknown_error";
                    if (RETRY_CONFIG.tokenExpiredErrors.includes(error)) {
                        throw new SlackAuthError(`Slack authentication failed: ${error}`, error);
                    }
                    throw new SlackRequestError(`Slack API error: ${error}`, response.status, error, text);
                }
                return data;
            }
            catch (error) {
                if (error instanceof SlackAuthError || error instanceof SlackRequestError) {
                    throw error;
                }
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < RETRY_CONFIG.maxRetries) {
                    await sleep(RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt));
                    continue;
                }
            }
        }
        throw new SlackRequestError(lastError?.message ?? "Unknown Slack request error", 0);
    }
}
export function newPostRequest(endpoint, credentials) {
    const url = endpoint.startsWith("http") ? endpoint : `${SLACK_API_BASE}/${endpoint}`;
    return new SlackRequest(url, credentials);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=request.js.map