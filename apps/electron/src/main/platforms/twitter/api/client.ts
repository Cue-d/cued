import { randomUUID } from 'node:crypto'
import {
  API_URLS,
  BASE_HEADERS,
  BASE_MESSAGES_URL,
  COOKIE_NAMES,
  CURRENT_CACHE_VERSION,
  DEFAULT_BEARER_TOKEN,
  GRAPHQL_QUERY_IDS,
  RETRY_CONFIG,
  TWITTER_BASE_URL,
} from './constants'
import type {
  AccountSettingsResponse,
  CachedSession,
  Cookie,
  DMRequestQuery,
  DMSendQuery,
  EditDirectMessagePayload,
  GetDMUserUpdatesResponse,
  InboxInitialStateResponse,
  SendDirectMessagePayload,
  TypeaheadSearchResponse,
  TypeaheadUser,
  TwitterInboxData,
  TwitterMessage,
} from './types'
import { defaultDMRequestQuery, defaultDMSendQuery, parseTwitterEvent } from './types'
import {
  parseCountry,
  parseGuestToken,
  parseLoadingAnimations,
  parseMainScriptURL,
  parseMigrateRequestData,
  parseMigrateURL,
  parseOndemandS,
  parseBearerTokens,
  parseVariableIndexes,
  parseVerificationToken,
} from './methods'
import {
  isAuthError,
  parseTwitterErrorPayload,
  TwitterApiError,
} from './errors'
import { generateAnimationState, signTransaction } from './crypto'

export interface SendDirectMessageResult {
  inbox: TwitterInboxData
  message: TwitterMessage | null
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: BodyInit
  contentType?: string
  allowRedirects?: boolean
}

interface APIRequestOptions {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: BodyInit
  contentType?: string
  referer?: string
  origin?: string
  withClientUUID?: boolean
}

export class TwitterClient {
  private cookieStore: Map<string, string>
  private session: CachedSession
  private variableIndexes: [number, number, number, number] | null = null
  private loadingAnimations: number[][][] | null = null

  constructor(options: { cookies?: Cookie[] } = {}) {
    this.cookieStore = new Map((options.cookies ?? []).map((cookie) => [cookie.name, cookie.value]))
    this.session = {
      initializedAt: 0,
      lastSaved: 0,
      pollingCursor: '',
      cacheVersion: CURRENT_CACHE_VERSION,
      verificationToken: '',
      animationToken: '',
      country: 'US',
      clientUUID: randomUUID(),
    }
  }

  get cookies(): Cookie[] {
    return [...this.cookieStore.entries()].map(([name, value]) => ({ name, value }))
  }

  setCookies(cookies: Cookie[]): void {
    this.cookieStore.clear()
    for (const cookie of cookies) {
      this.cookieStore.set(cookie.name, cookie.value)
    }
  }

  getSession(): CachedSession {
    return { ...this.session }
  }

  setSession(session: CachedSession): void {
    this.session = { ...session }
  }

  get pollingCursor(): string {
    return this.session.pollingCursor
  }

  set pollingCursor(cursor: string) {
    this.session.pollingCursor = cursor
  }

  isAuthenticated(): boolean {
    return Boolean(this.getCookie(COOKIE_NAMES.authToken))
  }

  getCurrentUserId(): string {
    const twid = this.getCookie(COOKIE_NAMES.twid) ?? ''
    const decoded = decodeURIComponent(twid)
    return decoded.replace('u=', '')
  }

  isSessionInitialized(): boolean {
    return this.session.initializedAt > 0
  }

  /**
   * Initialize the client session by loading the messages page HTML and parsing
   * tokens, animations, and scripts. Should be called once before making API requests.
   * Re-loading the page invalidates the server-side polling cursor, so this must
   * NOT be called on every sync cycle — only when the session hasn't been initialized yet.
   */
  async initializeSession(): Promise<void> {
    await this.loadPage(BASE_MESSAGES_URL)
    this.session.initializedAt = Date.now()
  }

  async getAccountSettings(): Promise<AccountSettingsResponse> {
    const query = queryString({
      include_ext_sharing_audiospaces_listening_data_with_followers: true,
      include_mention_filter: true,
      include_nsfw_user_flag: true,
      include_nsfw_admin_flag: true,
      include_ranked_timeline: true,
      include_alt_text_compose: true,
      ext: 'ssoConnections',
      include_country_code: true,
      include_ext_dm_nsfw_media_filter: true,
    })

    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.accountSettings}?${query}`,
      method: 'GET',
    })

    return JSON.parse(body) as AccountSettingsResponse
  }

  async getInitialInboxState(params: DMRequestQuery): Promise<InboxInitialStateResponse> {
    const query = queryString(params)
    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.inboxInitialState}?${query}`,
      method: 'GET',
      withClientUUID: true,
    })

    return JSON.parse(body) as InboxInitialStateResponse
  }

  async getDMUserUpdates(params: DMRequestQuery): Promise<GetDMUserUpdatesResponse> {
    const query = queryString(params)
    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.dmUserUpdates}?${query}`,
      method: 'GET',
      withClientUUID: true,
    })

    return JSON.parse(body) as GetDMUserUpdatesResponse
  }

  async fetchTrustedThreads(params: DMRequestQuery): Promise<{ inbox_timeline?: TwitterInboxData }> {
    const query = queryString(params)
    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.trustedInboxTimeline}?${query}`,
      method: 'GET',
      withClientUUID: true,
    })

    return JSON.parse(body) as { inbox_timeline?: TwitterInboxData }
  }

  async fetchConversationContext(
    conversationId: string,
    params: DMRequestQuery,
    context: 'FETCH_DM_CONVERSATION' | 'FETCH_DM_CONVERSATION_HISTORY'
  ): Promise<{ conversation_timeline?: TwitterInboxData }> {
    const payload = { ...params, context }
    const query = queryString(payload)

    const url = API_URLS.conversationFetchMessages.replace('%s', encodeURIComponent(conversationId))
    const { body } = await this.makeAPIRequest({
      url: `${url}?${query}`,
      method: 'GET',
      withClientUUID: true,
    })

    return JSON.parse(body) as { conversation_timeline?: TwitterInboxData }
  }

  async sendDirectMessage(conversationId: string, text: string): Promise<SendDirectMessageResult> {
    if (!text?.trim()) {
      throw new Error('Message text is required')
    }

    const sendQuery: DMSendQuery = defaultDMSendQuery()
    const query = queryString(sendQuery)

    const payload: SendDirectMessagePayload = {
      conversation_id: conversationId,
      text,
      request_id: randomUUID(),
      recipient_ids: false,
      dm_users: false,
      cards_platform: 'Web-12',
      include_cards: 1,
      include_quote_count: true,
      audio_only_media_attachment: false,
    }

    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.sendDM}?${query}`,
      method: 'POST',
      body: JSON.stringify(payload),
      contentType: 'application/json',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
      origin: TWITTER_BASE_URL,
      withClientUUID: true,
    })

    const inbox = JSON.parse(body) as TwitterInboxData

    const events = (inbox.entries ?? []).map(parseTwitterEvent)
    const messageEvent = events.find((e): e is { type: 'message'; data: TwitterMessage } => e.type === 'message')

    return { inbox, message: messageEvent?.data ?? null }
  }

  async searchUsers(query: string, count = 10): Promise<TypeaheadUser[]> {
    const params = queryString({
      q: query,
      src: 'compose_message',
      result_type: 'users',
      count,
    })

    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.searchTypeahead}?${params}`,
      method: 'GET',
    })

    const response = JSON.parse(body) as TypeaheadSearchResponse
    return response.users ?? []
  }

  async editDirectMessage(conversationId: string, messageId: string, text: string): Promise<TwitterMessage | null> {
    const sendQuery = defaultDMSendQuery()
    const query = queryString(sendQuery)

    const payload: EditDirectMessagePayload = {
      conversation_id: conversationId,
      dm_id: messageId,
      text,
      request_id: randomUUID(),
    }

    const { body } = await this.makeAPIRequest({
      url: `${API_URLS.editDM}?${query}`,
      method: 'POST',
      body: JSON.stringify(payload),
      contentType: 'application/json',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
      withClientUUID: true,
    })

    const inbox = JSON.parse(body) as TwitterInboxData
    const events = (inbox.entries ?? []).map(parseTwitterEvent)
    const messageEvent = events.find(
      (e): e is { type: 'message'; data: TwitterMessage } => e.type === 'message'
    )
    return messageEvent?.data ?? null
  }

  async markConversationRead(conversationId: string, lastReadEventId: string): Promise<void> {
    const url = API_URLS.conversationMarkRead.replace('%s', encodeURIComponent(conversationId))
    const form = new URLSearchParams({
      conversationId,
      last_read_event_id: lastReadEventId,
    })

    await this.makeAPIRequest({
      url,
      method: 'POST',
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
    })
  }

  async deleteMessage(messageId: string): Promise<void> {
    const variables = { messageId, requestId: randomUUID() }
    const payload = JSON.stringify({
      variables,
      queryId: GRAPHQL_QUERY_IDS.deleteMessage,
    })

    await this.makeAPIRequest({
      url: API_URLS.graphqlDeleteMessage,
      method: 'POST',
      body: payload,
      contentType: 'application/json',
    })
  }

  async react(conversationId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    const url = remove ? API_URLS.graphqlRemoveReaction : API_URLS.graphqlAddReaction
    const queryId = remove ? GRAPHQL_QUERY_IDS.removeReaction : GRAPHQL_QUERY_IDS.addReaction

    const variables = {
      conversationId,
      messageId,
      reactionTypes: ['Emoji'],
      emojiReactions: [emoji],
    }

    await this.makeAPIRequest({
      url,
      method: 'POST',
      body: JSON.stringify({ variables, queryId }),
      contentType: 'application/json',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
    })
  }

  async sendTypingNotification(conversationId: string): Promise<void> {
    const variables = { conversationId }
    await this.makeAPIRequest({
      url: API_URLS.graphqlTypingNotification,
      method: 'POST',
      body: JSON.stringify({
        variables,
        queryId: GRAPHQL_QUERY_IDS.typingNotification,
      }),
      contentType: 'application/json',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
    })
  }

  async acceptConversation(conversationId: string): Promise<void> {
    const url = API_URLS.acceptConversation.replace('%s', encodeURIComponent(conversationId))
    await this.makeAPIRequest({
      url,
      method: 'POST',
      referer: `${BASE_MESSAGES_URL}/${conversationId}`,
    })
  }

  async getScreenName(): Promise<string | undefined> {
    const settings = await this.getAccountSettings()
    return settings.screen_name
  }

  // ============================================================================
  // Bootstrap/session initialization
  // ============================================================================

  private async loadPage(url: string): Promise<void> {
    const documentHeaders: Record<string, string> = {
      'upgrade-insecure-requests': '1',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      cookie: this.toCookieHeader(),
    }

    let { body } = await this.makeRequest(url, {
      method: 'GET',
      headers: this.buildHeaders(documentHeaders),
    })

    const migrationURL = parseMigrateURL(body)
    if (migrationURL) {
      const migrationResponse = await this.makeRequest(migrationURL, {
        method: 'GET',
        headers: this.buildHeaders({
          'upgrade-insecure-requests': '1',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          referer: `${TWITTER_BASE_URL}/`,
          cookie: this.toCookieHeader(),
        }),
      })

      const migrationForm = parseMigrateRequestData(migrationResponse.body)
      if (migrationForm) {
        const form = new URLSearchParams({ tok: migrationForm.tok, data: migrationForm.data })
        const follow = await this.makeRequest(migrationForm.action, {
          method: 'POST',
          headers: this.buildHeaders({
            origin: TWITTER_BASE_URL,
            referer: `${TWITTER_BASE_URL}/`,
            cookie: this.toCookieHeader(),
          }),
          body: form.toString(),
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
          allowRedirects: true,
        })

        body = follow.body
      }
    }

    await this.parseMainPageHTML(body)
  }

  private async parseMainPageHTML(html: string): Promise<void> {
    const country = parseCountry(html)
    if (!country) {
      throw new Error('Could not parse country from messages page')
    }

    this.session.country = country

    const verificationToken = parseVerificationToken(html)
    if (verificationToken) {
      this.session.verificationToken = verificationToken
    }

    const guestToken = parseGuestToken(html)
    if (guestToken) {
      this.cookieStore.set(COOKIE_NAMES.guestToken, guestToken)
    }

    this.loadingAnimations = parseLoadingAnimations(html)

    // Fetch scripts so bearer token + variable indexes are ready before API calls
    const mainScriptURL = parseMainScriptURL(html)
    const ondemandS = parseOndemandS(html)

    await Promise.all([
      mainScriptURL ? this.fetchAndParseMainScript(mainScriptURL) : Promise.resolve(),
      ondemandS
        ? this.fetchAndParseSScript(
            `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${ondemandS}a.js`
          )
        : Promise.resolve(),
    ])

    this.calculateAnimationToken()
  }

  private async fetchScript(scriptURL: string): Promise<string | null> {
    try {
      const response = await this.makeRequest(scriptURL, {
        method: 'GET',
        headers: this.buildHeaders({
          accept: '*/*',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'script',
          origin: BASE_MESSAGES_URL,
          referer: `${BASE_MESSAGES_URL}/`,
        }),
      })
      return response.body
    } catch (error) {
      console.warn(`[TwitterClient] Failed to fetch script ${scriptURL}:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  private async fetchAndParseMainScript(scriptURL: string): Promise<void> {
    const body = await this.fetchScript(scriptURL)
    if (!body) return

    const tokens = parseBearerTokens(body)
    if (tokens.length > 0) {
      this.session.bearerToken = tokens[0]
    }
  }

  private async fetchAndParseSScript(scriptURL: string): Promise<void> {
    const body = await this.fetchScript(scriptURL)
    if (!body) return

    this.variableIndexes = parseVariableIndexes(body)
  }

  private calculateAnimationToken(): void {
    this.session.animationToken = generateAnimationState(
      this.variableIndexes,
      this.loadingAnimations,
      this.session.verificationToken
    )
  }

  // ============================================================================
  // Request handling
  // ============================================================================

  private async makeAPIRequest(options: APIRequestOptions): Promise<{ response: Response; body: string }> {
    let transactionId: string
    try {
      transactionId = signTransaction(
        this.session.animationToken,
        this.session.verificationToken,
        options.url,
        options.method ?? 'GET'
      )
    } catch (error) {
      console.warn('[TwitterClient] Transaction signing failed, using fallback:', error instanceof Error ? error.message : error)
      transactionId = Buffer.from('e:').toString('base64').replace(/=+$/, '')
    }

    const headers = this.buildHeaders({
      accept: '*/*',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      authorization: this.session.bearerToken ?? DEFAULT_BEARER_TOKEN,
      cookie: this.toCookieHeader(),
      'x-csrf-token': this.getCookie(COOKIE_NAMES.csrfToken) ?? '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'x-client-transaction-id': transactionId,
      ...(options.withClientUUID ? { 'x-client-uuid': this.session.clientUUID } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.referer ? { referer: options.referer } : {}),
      ...(options.headers ?? {}),
    })

    return this.makeRequest(options.url, {
      method: options.method,
      headers,
      body: options.body,
      contentType: options.contentType,
    })
  }

  private async makeRequest(
    url: string,
    options: RequestOptions = {}
  ): Promise<{ response: Response; body: string }> {
    const method = options.method ?? 'GET'
    const headers = { ...(options.headers ?? {}) }

    if (options.contentType) {
      headers['content-type'] = options.contentType
    }

    let lastError: unknown = null

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options.body,
          redirect: options.allowRedirects === false ? 'manual' : 'follow',
        })

        this.updateCookiesFromResponse(response)
        const body = await response.text()

        if (response.status >= 400) {
          const parsedError = parseTwitterErrorPayload(body)
          if (parsedError) {
            parsedError.statusCode = response.status
            throw parsedError
          }

          if (body.length === 0) {
            throw new TwitterApiError(`HTTP ${response.status} (no response body)`, response.status)
          }

          throw new TwitterApiError(
            `HTTP ${response.status}: ${body.slice(0, 512)}`,
            response.status
          )
        }

        return { response, body }
      } catch (error) {
        lastError = error

        if (error instanceof TwitterApiError) {
          const isRetryable =
            error.statusCode !== undefined &&
            (RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(error.statusCode)

          if (isAuthError(error) || !isRetryable) {
            throw error
          }
        }

        if (attempt >= RETRY_CONFIG.maxRetries) {
          throw error
        }

        const delayMs = RETRY_CONFIG.baseDelayMs * (attempt + 1)
        await sleep(delayMs)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private buildHeaders(overrides: Record<string, string>): Record<string, string> {
    return {
      ...BASE_HEADERS,
      ...overrides,
    }
  }

  private getCookie(name: string): string | undefined {
    return this.cookieStore.get(name)
  }

  private toCookieHeader(): string {
    return [...this.cookieStore.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private updateCookiesFromResponse(response: Response): void {
    const headers = response.headers as unknown as { getSetCookie?: () => string[] }

    let setCookies: string[]
    if (typeof headers.getSetCookie === 'function') {
      setCookies = headers.getSetCookie()
    } else {
      const single = response.headers.get('set-cookie')
      setCookies = single ? [single] : []
    }

    for (const setCookie of setCookies) {
      const firstPart = setCookie.split(';')[0]
      const separator = firstPart.indexOf('=')
      if (separator <= 0) continue

      const name = firstPart.slice(0, separator).trim()
      if (!name) continue

      this.cookieStore.set(name, firstPart.slice(separator + 1).trim())
    }
  }
}

function queryString(params: object): string {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }

  return query.toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
