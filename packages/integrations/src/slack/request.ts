/**
 * Slack API Request Builder
 * Handles authenticated requests with retry logic and error handling
 */

import { DEFAULT_HEADERS, RETRY_CONFIG, SLACK_API_BASE } from './constants'
import type { SlackCredentials } from './types'

// ============================================================================
// Error Types
// ============================================================================

export class SlackAuthError extends Error {
  constructor(
    message: string,
    public slackError: string
  ) {
    super(message)
    this.name = 'SlackAuthError'
  }
}

export class SlackRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public slackError?: string,
    public response?: string
  ) {
    super(message)
    this.name = 'SlackRequestError'
  }
}

export class SlackRateLimitError extends Error {
  constructor(
    message: string,
    public retryAfter: number
  ) {
    super(message)
    this.name = 'SlackRateLimitError'
  }
}

// ============================================================================
// Request Builder
// ============================================================================

type HttpMethod = 'GET' | 'POST'

interface RequestOptions {
  method: HttpMethod
  headers: Record<string, string>
  body?: string
}

export class SlackRequest {
  private method: HttpMethod = 'POST' // Slack API prefers POST
  private url: string
  private headers: Record<string, string> = {}
  private formData: Map<string, string> = new Map()
  private credentials: SlackCredentials

  constructor(baseUrl: string, credentials: SlackCredentials) {
    this.url = baseUrl
    this.credentials = credentials

    // Set default headers
    for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
      this.headers[key] = value
    }

    // Content-Type for form data (Slack API uses x-www-form-urlencoded)
    this.headers['Content-Type'] = 'application/x-www-form-urlencoded'

    // Set cookie header for browser token auth
    this.headers['Cookie'] = `d=${credentials.cookie}`
  }

  /**
   * Set HTTP method
   */
  withMethod(method: HttpMethod): this {
    this.method = method
    return this
  }

  /**
   * Add a header
   */
  withHeader(key: string, value: string): this {
    this.headers[key] = value
    return this
  }

  /**
   * Add form parameter (used by most Slack API methods)
   */
  withParam(key: string, value: string | number | boolean): this {
    this.formData.set(key, String(value))
    return this
  }

  /**
   * Add multiple form parameters
   */
  withParams(params: Record<string, string | number | boolean | undefined>): this {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        this.formData.set(key, String(value))
      }
    }
    return this
  }

  /**
   * Build request body
   */
  private buildBody(): string {
    // Always include token
    const params = new URLSearchParams()
    params.set('token', this.credentials.token)

    // Add form data
    for (const [key, value] of this.formData) {
      params.set(key, value)
    }

    return params.toString()
  }

  /**
   * Build request options
   */
  private buildRequestOptions(): RequestOptions {
    const options: RequestOptions = {
      method: this.method,
      headers: { ...this.headers },
    }

    if (this.method === 'POST') {
      options.body = this.buildBody()
    }

    return options
  }

  /**
   * Execute request with retry logic
   */
  async doRaw(): Promise<Response> {
    const options = this.buildRequestOptions()
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const response = await fetch(this.url, options)

        // Check for rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10)
          if (attempt < RETRY_CONFIG.maxRetries) {
            await sleep(retryAfter * 1000)
            continue
          }
          throw new SlackRateLimitError('Rate limited by Slack API', retryAfter)
        }

        // Check for auth errors
        if (
          (RETRY_CONFIG.authErrorStatusCodes as readonly number[]).includes(response.status)
        ) {
          throw new SlackAuthError(
            `Authentication failed: ${response.status} ${response.statusText}`,
            'http_auth_error'
          )
        }

        // Check for retriable HTTP errors
        if (
          (RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(response.status)
        ) {
          if (attempt < RETRY_CONFIG.maxRetries) {
            const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt)
            await sleep(delay)
            continue
          }
          throw new SlackRequestError(
            `Request failed after ${RETRY_CONFIG.maxRetries} retries: ${response.status}`,
            response.status
          )
        }

        return response
      } catch (error) {
        // Don't retry auth errors
        if (error instanceof SlackAuthError) {
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

        // Re-throw known errors
        if (error instanceof SlackRequestError || error instanceof SlackRateLimitError) {
          throw error
        }

        // Wrap unexpected errors
        throw new SlackRequestError(
          `Request failed: ${error instanceof Error ? error.message : String(error)}`,
          0
        )
      }
    }

    throw new SlackRequestError(
      `Request failed after ${RETRY_CONFIG.maxRetries} retries: ${lastError?.message ?? 'Unknown error'}`,
      0
    )
  }

  /**
   * Execute request and parse JSON response
   */
  async doJSON<T>(): Promise<T> {
    const response = await this.doRaw()
    const text = await response.text()

    let data: T & { ok?: boolean; error?: string }
    try {
      data = JSON.parse(text) as T & { ok?: boolean; error?: string }
    } catch {
      throw new SlackRequestError('Failed to parse JSON response', response.status, undefined, text)
    }

    // Check for Slack API errors (these come with 200 status)
    if (data.ok === false) {
      const error = data.error ?? 'unknown_error'

      // Check for auth-related errors
      if ((RETRY_CONFIG.tokenExpiredErrors as readonly string[]).includes(error)) {
        throw new SlackAuthError(`Slack authentication failed: ${error}`, error)
      }

      throw new SlackRequestError(`Slack API error: ${error}`, response.status, error, text)
    }

    return data
  }
}

// ============================================================================
// Request Factory Functions
// ============================================================================

/**
 * Create a new Slack API request
 */
export function newSlackRequest(endpoint: string, credentials: SlackCredentials): SlackRequest {
  const url = endpoint.startsWith('http') ? endpoint : `${SLACK_API_BASE}/${endpoint}`
  return new SlackRequest(url, credentials)
}

/**
 * Create a POST request (default for Slack API)
 */
export function newPostRequest(endpoint: string, credentials: SlackCredentials): SlackRequest {
  return newSlackRequest(endpoint, credentials).withMethod('POST')
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Check if an error is a Slack auth error (type guard)
 */
export function isSlackAuthError(error: unknown): error is SlackAuthError {
  return error instanceof SlackAuthError
}

/**
 * Check if an error indicates the token needs to be refreshed
 */
export function isTokenExpiredError(error: unknown): boolean {
  if (error instanceof SlackAuthError) {
    return (RETRY_CONFIG.tokenExpiredErrors as readonly string[]).includes(error.slackError)
  }
  return false
}
