import {
  API_URLS,
  CONTENT_TYPES,
  COOKIE_NAMES,
  DEFAULT_HEADERS,
  DEFAULT_X_LI_TRACK,
  GRAPHQL_QUERY_IDS,
  RETRY_CONFIG,
} from "./constants.js";
import type { Cookie } from "./types.js";

export class LinkedInAuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "LinkedInAuthError";
  }
}

export class LinkedInRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: string,
  ) {
    super(message);
    this.name = "LinkedInRequestError";
  }
}

function getCSRFToken(cookies: Cookie[]): string | null {
  const sessionCookie = cookies.find((cookie) => cookie.name === COOKIE_NAMES.sessionId);
  return sessionCookie ? sessionCookie.value.replace(/^"|"$/g, "") : null;
}

function formatCookieHeader(cookies: Cookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

type HttpMethod = "GET" | "POST";

class AuthedRequest {
  private method: HttpMethod = "GET";
  private headers: Record<string, string> = {};
  private queryParams = new Map<string, string>();
  private rawQuery: string | null = null;
  private body: string | null = null;

  constructor(
    private readonly url: string,
    private readonly cookies: Cookie[],
  ) {
    Object.assign(this.headers, DEFAULT_HEADERS);
    this.headers.Cookie = formatCookieHeader(cookies);
    const csrfToken = getCSRFToken(cookies);
    if (csrfToken) {
      this.headers["csrf-token"] = csrfToken;
    }
  }

  withMethod(method: HttpMethod): this {
    this.method = method;
    return this;
  }

  withHeader(key: string, value: string): this {
    this.headers[key] = value;
    return this;
  }

  withXLIHeaders(): this {
    this.headers["x-li-track"] = DEFAULT_X_LI_TRACK;
    return this;
  }

  withJSONPayload(data: unknown): this {
    this.body = JSON.stringify(data);
    this.headers["Content-Type"] = CONTENT_TYPES.jsonUtf8;
    return this;
  }

  withRawQuery(query: string): this {
    this.rawQuery = query;
    return this;
  }

  withQueryParam(key: string, value: string): this {
    this.queryParams.set(key, value);
    return this;
  }

  withGraphQLQuery(
    queryId: keyof typeof GRAPHQL_QUERY_IDS,
    variables: Record<string, string>,
  ): this {
    const fullQueryId = GRAPHQL_QUERY_IDS[queryId];
    this.headers.Accept = CONTENT_TYPES.graphql;
    this.headers.Referer = `${API_URLS.messagingBase}/`;
    this.headers["x-li-track"] = DEFAULT_X_LI_TRACK;
    this.headers["x-restli-protocol-version"] = "2.0.0";
    this.rawQuery = `queryId=${fullQueryId}&variables=${queriesToString(variables)}`;
    return this;
  }

  private buildUrl(): string {
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

  async doJSON<T>(): Promise<T> {
    const url = this.buildUrl();
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt += 1) {
      const response = await fetch(url, {
        method: this.method,
        headers: this.headers,
        body: this.body ?? undefined,
      });

      if ((RETRY_CONFIG.authErrorStatusCodes as readonly number[]).includes(response.status)) {
        throw new LinkedInAuthError(
          `Authentication failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      if ((RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(response.status)) {
        if (attempt < RETRY_CONFIG.maxRetries) {
          await sleep(RETRY_CONFIG.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new LinkedInRequestError(
          `Request failed after retries: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      if (!response.ok) {
        throw new LinkedInRequestError(
          `Request failed: ${response.status} ${response.statusText}`,
          response.status,
          await response.text(),
        );
      }

      return response.json() as Promise<T>;
    }

    throw new LinkedInRequestError("Request failed unexpectedly", 500);
  }
}

export function linkedInEncode(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":");
}

function queriesToString(variables: Record<string, string>): string {
  return `(${Object.entries(variables)
    .map(([key, value]) => `${key}:${value}`)
    .join(",")})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function newGetRequest(url: string, cookies: Cookie[]): AuthedRequest {
  return new AuthedRequest(url, cookies).withMethod("GET");
}

export function newPostRequest(url: string, cookies: Cookie[]): AuthedRequest {
  return new AuthedRequest(url, cookies).withMethod("POST");
}

export function newMessagingGraphQLRequest(
  cookies: Cookie[],
  queryId: keyof typeof GRAPHQL_QUERY_IDS,
  variables: Record<string, string>,
): AuthedRequest {
  return newGetRequest(API_URLS.messagingGraphQL, cookies).withGraphQLQuery(queryId, variables);
}
