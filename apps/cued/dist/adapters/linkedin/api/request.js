import { API_URLS, CONTENT_TYPES, COOKIE_NAMES, DEFAULT_HEADERS, DEFAULT_X_LI_TRACK, GRAPHQL_QUERY_IDS, RETRY_CONFIG, } from "./constants.js";
export class LinkedInAuthError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "LinkedInAuthError";
    }
}
export class LinkedInRequestError extends Error {
    statusCode;
    response;
    constructor(message, statusCode, response) {
        super(message);
        this.statusCode = statusCode;
        this.response = response;
        this.name = "LinkedInRequestError";
    }
}
function getCSRFToken(cookies) {
    const sessionCookie = cookies.find((cookie) => cookie.name === COOKIE_NAMES.sessionId);
    return sessionCookie ? sessionCookie.value.replace(/^"|"$/g, "") : null;
}
function formatCookieHeader(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
class AuthedRequest {
    url;
    cookies;
    method = "GET";
    headers = {};
    queryParams = new Map();
    rawQuery = null;
    body = null;
    constructor(url, cookies) {
        this.url = url;
        this.cookies = cookies;
        Object.assign(this.headers, DEFAULT_HEADERS);
        this.headers.Cookie = formatCookieHeader(cookies);
        const csrfToken = getCSRFToken(cookies);
        if (csrfToken) {
            this.headers["csrf-token"] = csrfToken;
        }
    }
    withMethod(method) {
        this.method = method;
        return this;
    }
    withHeader(key, value) {
        this.headers[key] = value;
        return this;
    }
    withXLIHeaders() {
        this.headers["x-li-track"] = DEFAULT_X_LI_TRACK;
        return this;
    }
    withJSONPayload(data) {
        this.body = JSON.stringify(data);
        this.headers["Content-Type"] = CONTENT_TYPES.jsonUtf8;
        return this;
    }
    withRawQuery(query) {
        this.rawQuery = query;
        return this;
    }
    withQueryParam(key, value) {
        this.queryParams.set(key, value);
        return this;
    }
    withGraphQLQuery(queryId, variables) {
        const fullQueryId = GRAPHQL_QUERY_IDS[queryId];
        this.headers.Accept = CONTENT_TYPES.graphql;
        this.headers.Referer = `${API_URLS.messagingBase}/`;
        this.headers["x-li-track"] = DEFAULT_X_LI_TRACK;
        this.headers["x-restli-protocol-version"] = "2.0.0";
        this.rawQuery = `queryId=${fullQueryId}&variables=${queriesToString(variables)}`;
        return this;
    }
    buildUrl() {
        if (this.rawQuery) {
            return `${this.url}?${this.rawQuery}`;
        }
        if (this.queryParams.size === 0) {
            return this.url;
        }
        const params = new URLSearchParams();
        for (const [key, value] of this.queryParams.entries()) {
            params.set(key, value);
        }
        return `${this.url}?${params.toString()}`;
    }
    async doJSON() {
        const url = this.buildUrl();
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt += 1) {
            const response = await fetch(url, {
                method: this.method,
                headers: this.headers,
                body: this.body ?? undefined,
            });
            if (RETRY_CONFIG.authErrorStatusCodes.includes(response.status)) {
                throw new LinkedInAuthError(`Authentication failed: ${response.status} ${response.statusText}`, response.status);
            }
            if (RETRY_CONFIG.retryableStatusCodes.includes(response.status)) {
                if (attempt < RETRY_CONFIG.maxRetries) {
                    await sleep(RETRY_CONFIG.baseDelayMs * 2 ** attempt);
                    continue;
                }
                throw new LinkedInRequestError(`Request failed after retries: ${response.status} ${response.statusText}`, response.status);
            }
            if (!response.ok) {
                throw new LinkedInRequestError(`Request failed: ${response.status} ${response.statusText}`, response.status, await response.text());
            }
            return response.json();
        }
        throw new LinkedInRequestError("Request failed unexpectedly", 500);
    }
}
export function linkedInEncode(value) {
    return encodeURIComponent(value).replaceAll("%3A", ":");
}
function queriesToString(variables) {
    return `(${Object.entries(variables)
        .map(([key, value]) => `${key}:${value}`)
        .join(",")})`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function newGetRequest(url, cookies) {
    return new AuthedRequest(url, cookies).withMethod("GET");
}
export function newPostRequest(url, cookies) {
    return new AuthedRequest(url, cookies).withMethod("POST");
}
export function newMessagingGraphQLRequest(cookies, queryId, variables) {
    return newGetRequest(API_URLS.messagingGraphQL, cookies).withGraphQLQuery(queryId, variables);
}
//# sourceMappingURL=request.js.map