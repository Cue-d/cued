import { describe, expect, it, vi } from 'vitest'
import { LinkedInClient } from '../client'
import type { Cookie, EventHandlers } from '../types'
import { COOKIE_NAMES, DEFAULT_X_LI_TRACK, USER_AGENT } from '../constants'

describe('LinkedInClient', () => {
  describe('constructor', () => {
    it('creates client with default options', () => {
      const client = new LinkedInClient()

      expect(client.cookies).toEqual([])
      expect(client.userEntityURN).toBeNull()
      expect(client.userAgent).toBe(USER_AGENT)
      expect(client.xLiTrack).toBe(DEFAULT_X_LI_TRACK)
      expect(client.eventHandlers).toEqual({})
    })

    it('creates client with provided cookies', () => {
      const cookies: Cookie[] = [
        { name: COOKIE_NAMES.authToken, value: 'token123' },
        { name: COOKIE_NAMES.sessionId, value: 'session456' },
      ]
      const client = new LinkedInClient({ cookies })

      expect(client.cookies).toEqual(cookies)
    })

    it('creates client with custom userAgent', () => {
      const customUserAgent = 'Custom User Agent'
      const client = new LinkedInClient({ userAgent: customUserAgent })

      expect(client.userAgent).toBe(customUserAgent)
    })

    it('creates client with custom xLiTrack', () => {
      const customTrack = JSON.stringify({ custom: 'track' })
      const client = new LinkedInClient({ xLiTrack: customTrack })

      expect(client.xLiTrack).toBe(customTrack)
    })

    it('creates client with event handlers', () => {
      const handlers: EventHandlers = {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
      }
      const client = new LinkedInClient({ eventHandlers: handlers })

      expect(client.eventHandlers).toBe(handlers)
    })
  })

  describe('cookie management', () => {
    describe('setCookies', () => {
      it('sets cookies on the client', () => {
        const client = new LinkedInClient()
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'new_token' },
        ]

        client.setCookies(cookies)

        expect(client.cookies).toEqual(cookies)
      })

      it('replaces existing cookies', () => {
        const client = new LinkedInClient({
          cookies: [{ name: 'old', value: 'cookie' }],
        })
        const newCookies: Cookie[] = [{ name: 'new', value: 'cookie' }]

        client.setCookies(newCookies)

        expect(client.cookies).toEqual(newCookies)
        expect(client.cookies).toHaveLength(1)
      })
    })

    describe('getCookie', () => {
      it('returns cookie by name', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'token123' },
          { name: COOKIE_NAMES.sessionId, value: 'session456' },
        ]
        const client = new LinkedInClient({ cookies })

        const cookie = client.getCookie(COOKIE_NAMES.authToken)

        expect(cookie).toEqual({ name: COOKIE_NAMES.authToken, value: 'token123' })
      })

      it('returns undefined for non-existent cookie', () => {
        const client = new LinkedInClient()

        expect(client.getCookie('nonexistent')).toBeUndefined()
      })
    })

    describe('getCookieValue', () => {
      it('returns cookie value by name', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'token123' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.getCookieValue(COOKIE_NAMES.authToken)).toBe('token123')
      })

      it('returns undefined for non-existent cookie', () => {
        const client = new LinkedInClient()

        expect(client.getCookieValue('nonexistent')).toBeUndefined()
      })
    })
  })

  describe('authentication', () => {
    describe('isAuthenticated', () => {
      it('returns true when both li_at and JSESSIONID cookies are present', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'auth_token_value' },
          { name: COOKIE_NAMES.sessionId, value: 'session_id_value' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(true)
      })

      it('returns false when li_at cookie is missing', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.sessionId, value: 'session_id_value' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(false)
      })

      it('returns false when JSESSIONID cookie is missing', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'auth_token_value' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(false)
      })

      it('returns false when no cookies are present', () => {
        const client = new LinkedInClient()

        expect(client.isAuthenticated()).toBe(false)
      })

      it('returns false when li_at cookie has empty value', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: '' },
          { name: COOKIE_NAMES.sessionId, value: 'session_id_value' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(false)
      })

      it('returns false when JSESSIONID cookie has empty value', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: 'auth_token_value' },
          { name: COOKIE_NAMES.sessionId, value: '' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(false)
      })

      it('returns false when both cookies have empty values', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.authToken, value: '' },
          { name: COOKIE_NAMES.sessionId, value: '' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.isAuthenticated()).toBe(false)
      })
    })

    describe('getSessionId', () => {
      it('returns session ID with quotes stripped', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.sessionId, value: '"ajax:1234567890"' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.getSessionId()).toBe('ajax:1234567890')
      })

      it('returns session ID without quotes unchanged', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.sessionId, value: 'ajax:1234567890' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.getSessionId()).toBe('ajax:1234567890')
      })

      it('returns null when JSESSIONID cookie is missing', () => {
        const client = new LinkedInClient()

        expect(client.getSessionId()).toBeNull()
      })

      it('returns null when JSESSIONID cookie has empty value', () => {
        const cookies: Cookie[] = [{ name: COOKIE_NAMES.sessionId, value: '' }]
        const client = new LinkedInClient({ cookies })

        expect(client.getSessionId()).toBeNull()
      })

      it('handles single leading quote', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.sessionId, value: '"ajax:1234567890' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.getSessionId()).toBe('ajax:1234567890')
      })

      it('handles single trailing quote', () => {
        const cookies: Cookie[] = [
          { name: COOKIE_NAMES.sessionId, value: 'ajax:1234567890"' },
        ]
        const client = new LinkedInClient({ cookies })

        expect(client.getSessionId()).toBe('ajax:1234567890')
      })
    })
  })

  describe('userEntityURN', () => {
    it('getter returns null initially', () => {
      const client = new LinkedInClient()

      expect(client.userEntityURN).toBeNull()
    })

    it('setter updates userEntityURN', () => {
      const client = new LinkedInClient()

      client.userEntityURN = 'urn:li:fsd_profile:ABC123'

      expect(client.userEntityURN).toBe('urn:li:fsd_profile:ABC123')
    })

    it('can be set to null', () => {
      const client = new LinkedInClient()
      client.userEntityURN = 'urn:li:fsd_profile:ABC123'

      client.userEntityURN = null

      expect(client.userEntityURN).toBeNull()
    })
  })

  describe('event handlers', () => {
    describe('setEventHandlers', () => {
      it('sets event handlers', () => {
        const client = new LinkedInClient()
        const handlers: EventHandlers = {
          onMessage: vi.fn(),
          onConversationUpdate: vi.fn(),
        }

        client.setEventHandlers(handlers)

        expect(client.eventHandlers).toBe(handlers)
      })

      it('replaces existing handlers', () => {
        const client = new LinkedInClient({
          eventHandlers: { onConnected: vi.fn() },
        })
        const newHandlers: EventHandlers = { onDisconnected: vi.fn() }

        client.setEventHandlers(newHandlers)

        expect(client.eventHandlers).toBe(newHandlers)
        expect(client.eventHandlers.onConnected).toBeUndefined()
      })
    })
  })

  describe('API method signatures', () => {
    // These methods are implemented in separate files (messages.ts, contacts.ts)
    // We just verify the method signatures exist and throw "Not implemented"

    it('getMessages throws not implemented', async () => {
      const client = new LinkedInClient()

      await expect(client.getMessages('conv-id')).rejects.toThrow(
        'Not implemented'
      )
    })

    it('getMessagesBefore throws not implemented', async () => {
      const client = new LinkedInClient()

      await expect(
        client.getMessagesBefore('conv-id', Date.now())
      ).rejects.toThrow('Not implemented')
    })

    it('sendMessage throws not implemented', async () => {
      const client = new LinkedInClient()

      await expect(client.sendMessage('conv-id', 'Hello')).rejects.toThrow(
        'Not implemented'
      )
    })

    it('getConnections throws not implemented', async () => {
      const client = new LinkedInClient()

      await expect(client.getConnections()).rejects.toThrow('Not implemented')
    })

    it('searchPeople throws not implemented', async () => {
      const client = new LinkedInClient()

      await expect(client.searchPeople('query')).rejects.toThrow(
        'Not implemented'
      )
    })
  })
})

describe('LinkedInClient cookie integration', () => {
  it('handles realistic LinkedIn cookie scenario', () => {
    const realisticCookies: Cookie[] = [
      {
        name: 'li_at',
        value: 'AQE...long_auth_token...',
        domain: '.linkedin.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      {
        name: 'JSESSIONID',
        value: '"ajax:1234567890123456789"',
        domain: '.linkedin.com',
        path: '/',
        secure: true,
      },
      {
        name: 'li_mc',
        value: 'some_mc_value',
        domain: '.linkedin.com',
      },
      {
        name: 'bcookie',
        value: 'browser_cookie_id',
        domain: '.linkedin.com',
      },
    ]

    const client = new LinkedInClient({ cookies: realisticCookies })

    expect(client.isAuthenticated()).toBe(true)
    expect(client.getSessionId()).toBe('ajax:1234567890123456789')
    expect(client.getCookieValue('li_at')).toBe('AQE...long_auth_token...')
    expect(client.getCookieValue('bcookie')).toBe('browser_cookie_id')
  })

  it('handles cookies with all optional fields', () => {
    const fullCookie: Cookie = {
      name: 'test_cookie',
      value: 'test_value',
      domain: '.example.com',
      path: '/app',
      expires: Date.now() + 86400000,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    }

    const client = new LinkedInClient({ cookies: [fullCookie] })

    const retrieved = client.getCookie('test_cookie')
    expect(retrieved).toEqual(fullCookie)
  })
})
