/**
 * LinkedIn API Request Builder
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/request.go
 */

import {
  API_URLS,
  CONTENT_TYPES,
  COOKIE_NAMES,
  DEFAULT_HEADERS,
  DEFAULT_X_LI_TRACK,
  GRAPHQL_QUERY_IDS,
  RETRY_CONFIG,
} from './constants'
import type { Cookie } from './types'

// ============================================================================
// Error Types
// ============================================================================

export class LinkedInAuthError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message)
    this.name = 'LinkedInAuthError'
  }
}

export class LinkedInRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: string
  ) {
    super(message)
    this.name = 'LinkedInRequestError'
  }
}

// ============================================================================
// CSRF Token Extraction
// ============================================================================

/**
 * Extract CSRF token from JSESSIONID cookie
 * The JSESSIONID cookie value may be wrapped in quotes, which need to be removed
 */
export function getCSRFToken(cookies: Cookie[]): string | null {
  const sessionCookie = cookies.find((c) => c.name === COOKIE_NAMES.sessionId)
  if (!sessionCookie) {
    return null
  }
  // Remove surrounding quotes if present (e.g., "ajax:123456" -> ajax:123456)
  return sessionCookie.value.replace(/^"|"$/g, '')
}

/**
 * Format cookies as a Cookie header string
 */
export function formatCookieHeader(cookies: Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

// ============================================================================
// Request Builder
// ============================================================================

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface RequestOptions {
  method: HttpMethod
  headers: Record<string, string>
  body?: string
}

export class AuthedRequest {
  private method: HttpMethod = 'GET'
  private url: string
  private headers: Record<string, string> = {}
  private queryParams: Map<string, string> = new Map()
  private rawQuery: string | null = null
  private body: string | null = null
  private cookies: Cookie[]

  constructor(baseUrl: string, cookies: Cookie[]) {
    this.url = baseUrl
    this.cookies = cookies

    // Set default headers
    Object.entries(DEFAULT_HEADERS).forEach(([key, value]) => {
      this.headers[key] = value
    })

    // Set cookie header
    this.headers['Cookie'] = formatCookieHeader(cookies)

    // Set CSRF token header
    const csrfToken = getCSRFToken(cookies)
    if (csrfToken) {
      this.headers['csrf-token'] = csrfToken
    }
  }

  /**
   * Set the HTTP method
   */
  withMethod(method: HttpMethod): this {
    this.method = method
    return this
  }

  /**
   * Add a header to the request
   */
  withHeader(key: string, value: string): this {
    this.headers[key] = value
    return this
  }

  /**
   * Add a query parameter
   */
  withQueryParam(key: string, value: string): this {
    this.queryParams.set(key, value)
    return this
  }

  /**
   * Set raw query string (takes precedence over queryParams)
   */
  withRawQuery(query: string): this {
    this.rawQuery = query
    return this
  }

  /**
   * Set JSON payload for the request body
   */
  withJSONPayload(data: unknown): this {
    this.body = JSON.stringify(data)
    this.headers['Content-Type'] = CONTENT_TYPES.jsonUtf8
    return this
  }

  /**
   * Configure request for GraphQL query
   * Uses LinkedIn's GraphQL query ID mapping system
   */
  withGraphQLQuery(
    queryId: keyof typeof GRAPHQL_QUERY_IDS,
    variables: Record<string, unknown>
  ): this {
    const fullQueryId = GRAPHQL_QUERY_IDS[queryId]

    // Set GraphQL-specific headers
    this.headers['Accept'] = CONTENT_TYPES.linkedInNormalized
    this.headers['x-li-track'] = DEFAULT_X_LI_TRACK

    // Add query parameters for GraphQL
    this.withQueryParam('queryId', fullQueryId)
    this.withQueryParam('variables', JSON.stringify(variables))

    return this
  }

  /**
   * Add x-li-* headers commonly used by LinkedIn API
   */
  withXLIHeaders(): this {
    this.headers['x-li-track'] = DEFAULT_X_LI_TRACK
    return this
  }

  /**
   * Build the final URL with query parameters
   */
  private buildUrl(): string {
    if (this.rawQuery) {
      return `${this.url}?${this.rawQuery}`
    }

    if (this.queryParams.size === 0) {
      return this.url
    }

    const params = new URLSearchParams()
    this.queryParams.forEach((value, key) => {
      params.set(key, value)
    })

    return `${this.url}?${params.toString()}`
  }

  /**
   * Build request options
   */
  private buildRequestOptions(): RequestOptions {
    const options: RequestOptions = {
      method: this.method,
      headers: { ...this.headers },
    }

    if (this.body) {
      options.body = this.body
    }

    return options
  }

  /**
   * Execute the request with retry logic
   * Implements exponential backoff for transient failures
   */
  async doRaw(): Promise<Response> {
    const url = this.buildUrl()
    const options = this.buildRequestOptions()

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const response = await fetch(url, options)

        // Check for auth errors - don't retry these
        if (
          (RETRY_CONFIG.authErrorStatusCodes as readonly number[]).includes(
            response.status
          )
        ) {
          throw new LinkedInAuthError(
            `Authentication failed: ${response.status} ${response.statusText}`,
            response.status
          )
        }

        // Check for retriable errors
        if (
          (RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(
            response.status
          )
        ) {
          if (attempt < RETRY_CONFIG.maxRetries) {
            const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt)
            await sleep(delay)
            continue
          }
          throw new LinkedInRequestError(
            `Request failed after ${RETRY_CONFIG.maxRetries} retries: ${response.status} ${response.statusText}`,
            response.status
          )
        }

        // Success or non-retriable error
        return response
      } catch (error) {
        // Don't retry auth errors
        if (error instanceof LinkedInAuthError) {
          throw error
        }

        // Network errors are retriable
        if (error instanceof TypeError && error.message.includes('fetch')) {
          lastError = error
          if (attempt < RETRY_CONFIG.maxRetries) {
            const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt)
            await sleep(delay)
            continue
          }
        }

        // Re-throw non-retriable errors
        if (error instanceof LinkedInRequestError) {
          throw error
        }

        // Wrap unexpected errors
        throw new LinkedInRequestError(
          `Request failed: ${error instanceof Error ? error.message : String(error)}`,
          0
        )
      }
    }

    throw new LinkedInRequestError(
      `Request failed after ${RETRY_CONFIG.maxRetries} retries: ${lastError?.message ?? 'Unknown error'}`,
      0
    )
  }

  /**
   * Execute request and parse JSON response
   */
  async doJSON<T>(): Promise<T> {
    const response = await this.doRaw()

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LinkedInRequestError(
        `Request failed: ${response.status} ${response.statusText}`,
        response.status,
        text
      )
    }

    return response.json() as Promise<T>
  }
}

// ============================================================================
// Request Factory Functions
// ============================================================================

/**
 * Create a new authenticated request builder
 */
export function newRequest(url: string, cookies: Cookie[]): AuthedRequest {
  return new AuthedRequest(url, cookies)
}

/**
 * Create a GET request
 */
export function newGetRequest(url: string, cookies: Cookie[]): AuthedRequest {
  return new AuthedRequest(url, cookies).withMethod('GET')
}

/**
 * Create a POST request
 */
export function newPostRequest(url: string, cookies: Cookie[]): AuthedRequest {
  return new AuthedRequest(url, cookies).withMethod('POST')
}

/**
 * Create a GraphQL request to the messaging endpoint
 */
export function newMessagingGraphQLRequest(
  cookies: Cookie[],
  queryId: keyof typeof GRAPHQL_QUERY_IDS,
  variables: Record<string, unknown>
): AuthedRequest {
  return new AuthedRequest(API_URLS.messagingGraphQL, cookies)
    .withMethod('GET')
    .withGraphQLQuery(queryId, variables)
}

/**
 * Create a GraphQL request to the voyager endpoint
 */
export function newVoyagerGraphQLRequest(
  cookies: Cookie[],
  queryId: keyof typeof GRAPHQL_QUERY_IDS,
  variables: Record<string, unknown>
): AuthedRequest {
  return new AuthedRequest(API_URLS.voyagerGraphQL, cookies)
    .withMethod('GET')
    .withGraphQLQuery(queryId, variables)
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
