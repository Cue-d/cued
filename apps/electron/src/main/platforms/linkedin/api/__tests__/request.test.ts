import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthedRequest,
  LinkedInAuthError,
  LinkedInRequestError,
  formatCookieHeader,
  getCSRFToken,
  newGetRequest,
  newMessagingGraphQLRequest,
  newPostRequest,
  newRequest,
  newVoyagerGraphQLRequest,
} from '../request'
import type { Cookie } from '../types'
import { COOKIE_NAMES, RETRY_CONFIG } from '../constants'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('getCSRFToken', () => {
  it('extracts token from JSESSIONID cookie', () => {
    const cookies: Cookie[] = [
      { name: COOKIE_NAMES.sessionId, value: 'ajax:1234567890' },
    ]
    expect(getCSRFToken(cookies)).toBe('ajax:1234567890')
  })

  it('removes surrounding quotes from JSESSIONID value', () => {
    const cookies: Cookie[] = [
      { name: COOKIE_NAMES.sessionId, value: '"ajax:1234567890"' },
    ]
    expect(getCSRFToken(cookies)).toBe('ajax:1234567890')
  })

  it('handles single leading quote', () => {
    const cookies: Cookie[] = [
      { name: COOKIE_NAMES.sessionId, value: '"ajax:1234567890' },
    ]
    expect(getCSRFToken(cookies)).toBe('ajax:1234567890')
  })

  it('handles single trailing quote', () => {
    const cookies: Cookie[] = [
      { name: COOKIE_NAMES.sessionId, value: 'ajax:1234567890"' },
    ]
    expect(getCSRFToken(cookies)).toBe('ajax:1234567890')
  })

  it('returns null when JSESSIONID cookie is missing', () => {
    const cookies: Cookie[] = [{ name: 'other_cookie', value: 'value' }]
    expect(getCSRFToken(cookies)).toBeNull()
  })

  it('returns null for empty cookie array', () => {
    expect(getCSRFToken([])).toBeNull()
  })
})

describe('formatCookieHeader', () => {
  it('formats single cookie', () => {
    const cookies: Cookie[] = [{ name: 'session', value: 'abc123' }]
    expect(formatCookieHeader(cookies)).toBe('session=abc123')
  })

  it('formats multiple cookies with semicolon separator', () => {
    const cookies: Cookie[] = [
      { name: 'session', value: 'abc123' },
      { name: 'token', value: 'xyz789' },
    ]
    expect(formatCookieHeader(cookies)).toBe('session=abc123; token=xyz789')
  })

  it('returns empty string for empty array', () => {
    expect(formatCookieHeader([])).toBe('')
  })
})

describe('AuthedRequest', () => {
  const testCookies: Cookie[] = [
    { name: COOKIE_NAMES.authToken, value: 'auth_token_value' },
    { name: COOKIE_NAMES.sessionId, value: '"ajax:csrf123"' },
  ]

  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('sets default headers', () => {
      const request = new AuthedRequest('https://example.com', testCookies)
      // We can't directly inspect headers, but we can test behavior via doRaw
      expect(request).toBeInstanceOf(AuthedRequest)
    })

    it('sets CSRF token header from JSESSIONID', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            'csrf-token': 'ajax:csrf123',
          }),
        })
      )
    })

    it('sets Cookie header from cookies', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: 'li_at=auth_token_value; JSESSIONID="ajax:csrf123"',
          }),
        })
      )
    })
  })

  describe('withMethod', () => {
    it('sets the HTTP method', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.withMethod('POST').doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('withHeader', () => {
    it('adds custom header', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.withHeader('X-Custom', 'custom-value').doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom': 'custom-value',
          }),
        })
      )
    })
  })

  describe('withQueryParam', () => {
    it('adds query parameters to URL', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.withQueryParam('key', 'value').doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('key=value'),
        expect.any(Object)
      )
    })

    it('encodes query parameter values', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.withQueryParam('key', 'value with spaces').doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('key=value+with+spaces'),
        expect.any(Object)
      )
    })
  })

  describe('withRawQuery', () => {
    it('sets raw query string (takes precedence over queryParams)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request
        .withQueryParam('ignored', 'param')
        .withRawQuery('raw=query&string=here')
        .doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com?raw=query&string=here',
        expect.any(Object)
      )
    })
  })

  describe('withJSONPayload', () => {
    it('sets JSON body and content-type header', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request
        .withMethod('POST')
        .withJSONPayload({ key: 'value' })
        .doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          body: JSON.stringify({ key: 'value' }),
          headers: expect.objectContaining({
            'Content-Type': 'application/json; charset=UTF-8',
          }),
        })
      )
    })
  })

  describe('withGraphQLQuery', () => {
    it('sets GraphQL query parameters and headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request
        .withGraphQLQuery('messengerConversations', { count: '20' })
        .doRaw()

      const [url, options] = mockFetch.mock.calls[0]

      // Check query params include queryId and variables
      expect(url).toContain('queryId=')
      expect(url).toContain('variables=')

      // Check headers
      expect(options.headers['Accept']).toBe('application/graphql')
      expect(options.headers['x-li-track']).toBeDefined()
    })
  })

  describe('withXLIHeaders', () => {
    it('adds x-li-track header', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      await request.withXLIHeaders().doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-li-track': expect.any(String),
          }),
        })
      )
    })
  })

  describe('doRaw - auth errors', () => {
    it('throws LinkedInAuthError on 401 status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doRaw()).rejects.toThrow(LinkedInAuthError)
    })

    it('throws LinkedInAuthError with correct statusCode on 401', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doRaw()).rejects.toMatchObject({
        statusCode: 401,
        name: 'LinkedInAuthError',
      })
    })

    it('throws LinkedInAuthError on 403 status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doRaw()).rejects.toThrow(LinkedInAuthError)
    })

    it('does not retry auth errors', async () => {
      mockFetch.mockResolvedValue(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doRaw()).rejects.toThrow(LinkedInAuthError)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('doRaw - retry logic', () => {
    it('retries on 502 status', async () => {
      // First call fails with 502, second succeeds
      mockFetch
        .mockResolvedValueOnce(
          new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      const response = await request.doRaw()

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on 503 status', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response('Service Unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
          })
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      const response = await request.doRaw()

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on 504 status', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response('Gateway Timeout', {
            status: 504,
            statusText: 'Gateway Timeout',
          })
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      const response = await request.doRaw()

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('throws after max retries exhausted', async () => {
      // All calls fail with 502
      mockFetch.mockResolvedValue(
        new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doRaw()).rejects.toThrow(LinkedInRequestError)
      // Initial attempt + maxRetries
      expect(mockFetch).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1)
    }, 60000) // Increase timeout for retry delays

    it('succeeds after multiple transient failures', async () => {
      // Fail 3 times, then succeed
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 502 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 504 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = new AuthedRequest('https://example.com', testCookies)
      const response = await request.doRaw()

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    }, 30000)

    it('does not retry on non-retriable error status codes', async () => {
      mockFetch.mockResolvedValue(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)
      const response = await request.doRaw()

      // 400 is not retriable, should return immediately
      expect(response.status).toBe(400)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('doJSON', () => {
    it('parses JSON response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      const request = new AuthedRequest('https://example.com', testCookies)
      const result = await request.doJSON<{ data: string }>()

      expect(result).toEqual({ data: 'test' })
    })

    it('throws LinkedInRequestError on non-ok status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doJSON()).rejects.toThrow(LinkedInRequestError)
    })

    it('throws LinkedInRequestError with correct statusCode on non-ok status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' })
      )

      const request = new AuthedRequest('https://example.com', testCookies)

      await expect(request.doJSON()).rejects.toMatchObject({
        statusCode: 404,
      })
    })
  })
})

describe('request factory functions', () => {
  const testCookies: Cookie[] = [
    { name: COOKIE_NAMES.authToken, value: 'token' },
    { name: COOKIE_NAMES.sessionId, value: 'session' },
  ]

  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('newRequest', () => {
    it('creates an AuthedRequest instance', () => {
      const request = newRequest('https://example.com', testCookies)
      expect(request).toBeInstanceOf(AuthedRequest)
    })
  })

  describe('newGetRequest', () => {
    it('creates a GET request', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = newGetRequest('https://example.com', testCookies)
      await request.doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ method: 'GET' })
      )
    })
  })

  describe('newPostRequest', () => {
    it('creates a POST request', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = newPostRequest('https://example.com', testCookies)
      await request.doRaw()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('newMessagingGraphQLRequest', () => {
    it('creates a GraphQL request to messaging endpoint', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = newMessagingGraphQLRequest(
        testCookies,
        'messengerConversations',
        { count: '20' }
      )
      await request.doRaw()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('voyagerMessagingGraphQL')
    })
  })

  describe('newVoyagerGraphQLRequest', () => {
    it('creates a GraphQL request to voyager endpoint', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = newVoyagerGraphQLRequest(
        testCookies,
        'messengerConversations',
        { count: '20' }
      )
      await request.doRaw()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('voyager/api/graphql')
      expect(url).not.toContain('voyagerMessagingGraphQL')
    })
  })
})

describe('LinkedInAuthError', () => {
  it('has correct name and properties', () => {
    const error = new LinkedInAuthError('Auth failed', 401)

    expect(error.name).toBe('LinkedInAuthError')
    expect(error.message).toBe('Auth failed')
    expect(error.statusCode).toBe(401)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('LinkedInRequestError', () => {
  it('has correct name and properties', () => {
    const error = new LinkedInRequestError('Request failed', 500, 'response body')

    expect(error.name).toBe('LinkedInRequestError')
    expect(error.message).toBe('Request failed')
    expect(error.statusCode).toBe(500)
    expect(error.response).toBe('response body')
    expect(error).toBeInstanceOf(Error)
  })

  it('works without response body', () => {
    const error = new LinkedInRequestError('Request failed', 500)

    expect(error.response).toBeUndefined()
  })
})
