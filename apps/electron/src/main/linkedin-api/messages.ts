/**
 * LinkedIn Messages API
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/messages.go
 */

import { API_URLS, PAGINATION_DEFAULTS, CONTENT_TYPES } from './constants'
import { newMessagingGraphQLRequest, newPostRequest } from './request'
import { URN } from './urn'
import type { LinkedInClient, MessagesResult } from './client'
import type {
  Message,
  GraphQLResponse,
  AttributedText,
  PagingMetadata,
} from './types'

// ============================================================================
// Response Types (internal)
// ============================================================================

interface MessagesGraphQLResponse {
  data?: {
    messengerMessagesByConversation?: {
      elements: RawMessage[]
      paging?: {
        start?: number
        count?: number
        total?: number
      }
    }
    messengerMessagesByAnchorTimestamp?: {
      elements: RawMessage[]
      paging?: {
        start?: number
        count?: number
        total?: number
      }
    }
  }
}

interface RawMessage {
  entityUrn?: string
  body?: {
    text?: string
    attributes?: Array<{
      start: number
      length: number
      type: string
      [key: string]: unknown
    }>
  }
  deliveredAt?: number
  sender?: {
    entityUrn?: string
    participantType?: {
      member?: {
        profileUrl?: string
        firstName?: string
        lastName?: string
        headline?: string
        picture?: {
          url?: string
          width?: number
          height?: number
        }
      }
      organization?: {
        name?: string
        logoUrl?: string
        pageUrl?: string
      }
    }
  }
  messageBodyRenderFormat?: 'DEFAULT' | 'EDITED' | 'RECALLED' | 'SYSTEM'
  renderContent?: Array<{
    audio?: { url: string; duration?: number }
    file?: { name: string; url: string; mediaType?: string; size?: number }
    video?: {
      url: string
      thumbnail?: { url: string; width?: number; height?: number }
      duration?: number
    }
    image?: { url: string; width?: number; height?: number }
    externalMedia?: {
      url: string
      title?: string
      description?: string
      previewImage?: { url: string; width?: number; height?: number }
    }
    forwardedMessage?: {
      originalMessageURN?: string
      originalSender?: RawMessage['sender']
    }
    repliedMessage?: {
      originalMessageURN?: string
      originalSender?: RawMessage['sender']
      originalBody?: RawMessage['body']
    }
  }>
  reactionSummaries?: Array<{
    emoji: string
    count: number
    viewerReacted: boolean
  }>
  conversationUrn?: string
  backendUrn?: string
  '*conversation'?: string
}

interface SendMessagePayload {
  message: {
    body: {
      attributes: Array<{
        start: number
        length: number
        type: { [key: string]: string }
      }>
      text: string
    }
    renderContentUnions?: Array<Record<string, unknown>>
    originToken: string
    conversationUrn: string
  }
  mailboxUrn: string
  trackingId: string
  dedupeByClientGeneratedToken: boolean
}

interface SendMessageResponse {
  value?: RawMessage
  data?: {
    '*elements'?: string[]
  }
}

// ============================================================================
// Message Fetching Functions
// ============================================================================

/**
 * Fetch messages for a conversation.
 * @param client - The LinkedIn client
 * @param conversationId - The conversation URN or ID
 * @param cursor - Optional cursor for pagination (not used in initial fetch)
 * @returns Promise resolving to messages with pagination metadata
 */
export async function getMessages(
  client: LinkedInClient,
  conversationId: string,
  cursor?: string
): Promise<MessagesResult> {
  // Ensure conversationId is a full URN
  const conversationURN = ensureConversationURN(conversationId)

  const variables: Record<string, string> = {
    conversationUrn: conversationURN,
    count: String(PAGINATION_DEFAULTS.messagesCount),
  }

  // Add cursor if provided (for pagination)
  if (cursor) {
    variables.start = cursor
  }

  const response = await newMessagingGraphQLRequest(
    client.cookies,
    'messengerMessagesByConversation',
    variables
  ).doJSON<MessagesGraphQLResponse>()

  const messagesData = response.data?.messengerMessagesByConversation
  if (!messagesData) {
    return { messages: [], metadata: undefined }
  }

  const messages = messagesData.elements.map((raw) =>
    parseRawMessage(raw, conversationURN)
  )
  const metadata = parsePagingMetadata(messagesData.paging)

  return { messages, metadata }
}

/**
 * Fetch messages before a given timestamp (for pagination/backfill).
 * Uses the MessengerMessagesByAnchorTimestamp GraphQL query.
 * @param client - The LinkedIn client
 * @param conversationId - The conversation URN or ID
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Promise resolving to messages with pagination metadata
 */
export async function getMessagesBefore(
  client: LinkedInClient,
  conversationId: string,
  timestamp: number
): Promise<MessagesResult> {
  // Ensure conversationId is a full URN
  const conversationURN = ensureConversationURN(conversationId)

  const variables: Record<string, string> = {
    conversationUrn: conversationURN,
    anchorTimestamp: String(timestamp),
    countBefore: String(PAGINATION_DEFAULTS.messagesCount),
    countAfter: '0',
  }

  const response = await newMessagingGraphQLRequest(
    client.cookies,
    'messengerMessagesByAnchorTimestamp',
    variables
  ).doJSON<MessagesGraphQLResponse>()

  const messagesData = response.data?.messengerMessagesByAnchorTimestamp
  if (!messagesData) {
    return { messages: [], metadata: undefined }
  }

  const messages = messagesData.elements.map((raw) =>
    parseRawMessage(raw, conversationURN)
  )
  const metadata = parsePagingMetadata(messagesData.paging)

  return { messages, metadata }
}

/**
 * Send a message to a conversation.
 * @param client - The LinkedIn client
 * @param conversationId - The conversation URN or ID
 * @param text - The message text to send
 * @returns Promise resolving to the sent message
 */
export async function sendMessage(
  client: LinkedInClient,
  conversationId: string,
  text: string
): Promise<Message> {
  // Ensure conversationId is a full URN
  const conversationURN = ensureConversationURN(conversationId)

  // Get the user's mailbox URN from the authenticated user
  if (!client.userEntityURN) {
    throw new Error('Client must have userEntityURN set to send messages')
  }

  // Convert fsd_profile URN to mailbox URN format
  // e.g., "urn:li:fsd_profile:ABC123" -> "urn:li:fsd_profile:ABC123"
  const mailboxURN = client.userEntityURN

  // Generate origin token for deduplication (UUID-like format)
  const originToken = generateOriginToken()
  const trackingId = generateTrackingId()

  const payload: SendMessagePayload = {
    message: {
      body: {
        attributes: [],
        text: text,
      },
      originToken: originToken,
      conversationUrn: conversationURN,
    },
    mailboxUrn: mailboxURN,
    trackingId: trackingId,
    dedupeByClientGeneratedToken: true,
  }

  const response = await newPostRequest(API_URLS.messagingMessages, client.cookies)
    .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
    .withXLIHeaders()
    .withJSONPayload(payload)
    .doJSON<SendMessageResponse>()

  // Parse the response - LinkedIn returns the created message
  if (response.value) {
    return parseRawMessage(response.value, conversationURN)
  }

  // If we didn't get the message back, construct a minimal one
  return {
    entityURN: `urn:li:fsd_message:${originToken}`,
    body: { text, attributes: [] },
    deliveredAt: Date.now(),
    sender: {
      entityURN: mailboxURN,
      participantType: {},
    },
    messageBodyRenderFormat: 'DEFAULT',
    conversationURN: conversationURN,
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Ensure a conversation ID is a full URN.
 * @param conversationId - The conversation ID or URN
 * @returns The full conversation URN
 */
function ensureConversationURN(conversationId: string): string {
  // If it already looks like a URN, return as-is
  if (conversationId.startsWith('urn:')) {
    return conversationId
  }
  // Otherwise, construct the URN
  return `urn:li:fsd_conversation:${conversationId}`
}

/**
 * Parse raw message data from GraphQL response into Message type.
 */
function parseRawMessage(raw: RawMessage, conversationURN: string): Message {
  const body: AttributedText = {
    text: raw.body?.text ?? '',
    attributes: raw.body?.attributes?.map((attr) => {
      // Extract known fields and spread the rest as extra properties
      const { start, length, type, ...rest } = attr
      return { start, length, type, ...rest }
    }),
  }

  // Helper to convert raw picture to VectorImage
  const parseVectorImage = (
    pic?: { url?: string; width?: number; height?: number }
  ) => {
    if (!pic?.url) return undefined
    return { url: pic.url, width: pic.width, height: pic.height }
  }

  // Helper to parse raw sender to MessagingParticipant
  const parseSender = (
    sender?: RawMessage['sender']
  ): Message['sender'] => {
    if (!sender) {
      return { entityURN: '', participantType: {} }
    }
    return {
      entityURN: sender.entityUrn ?? '',
      participantType: {
        member: sender.participantType?.member
          ? {
              profileUrl: sender.participantType.member.profileUrl ?? '',
              firstName: sender.participantType.member.firstName ?? '',
              lastName: sender.participantType.member.lastName ?? '',
              headline: sender.participantType.member.headline,
              picture: parseVectorImage(sender.participantType.member.picture),
            }
          : undefined,
        organization: sender.participantType?.organization
          ? {
              name: sender.participantType.organization.name ?? '',
              logoUrl: sender.participantType.organization.logoUrl,
              pageUrl: sender.participantType.organization.pageUrl,
            }
          : undefined,
      },
    }
  }

  return {
    entityURN: raw.entityUrn ?? raw.backendUrn ?? '',
    body,
    deliveredAt: raw.deliveredAt ?? 0,
    sender: parseSender(raw.sender),
    messageBodyRenderFormat: raw.messageBodyRenderFormat ?? 'DEFAULT',
    renderContent: raw.renderContent?.map((rc) => ({
      audio: rc.audio,
      file: rc.file,
      video: rc.video
        ? {
            url: rc.video.url,
            thumbnail: parseVectorImage(rc.video.thumbnail),
            duration: rc.video.duration,
          }
        : undefined,
      image: parseVectorImage(rc.image),
      externalMedia: rc.externalMedia
        ? {
            url: rc.externalMedia.url,
            title: rc.externalMedia.title,
            description: rc.externalMedia.description,
            previewImage: parseVectorImage(rc.externalMedia.previewImage),
          }
        : undefined,
      forwardedMessage: rc.forwardedMessage
        ? {
            originalMessageURN: rc.forwardedMessage.originalMessageURN ?? '',
            originalSender: rc.forwardedMessage.originalSender
              ? parseSender(rc.forwardedMessage.originalSender)
              : undefined,
          }
        : undefined,
      repliedMessage: rc.repliedMessage
        ? {
            originalMessageURN: rc.repliedMessage.originalMessageURN ?? '',
            originalSender: rc.repliedMessage.originalSender
              ? parseSender(rc.repliedMessage.originalSender)
              : undefined,
            originalBody: rc.repliedMessage.originalBody
              ? {
                  text: rc.repliedMessage.originalBody.text ?? '',
                  attributes: rc.repliedMessage.originalBody.attributes,
                }
              : undefined,
          }
        : undefined,
    })),
    reactionSummaries: raw.reactionSummaries,
    conversationURN: raw.conversationUrn ?? raw['*conversation'] ?? conversationURN,
  }
}

/**
 * Parse paging metadata from GraphQL response.
 */
function parsePagingMetadata(
  paging?: { start?: number; count?: number; total?: number }
): PagingMetadata | undefined {
  if (!paging) return undefined
  return {
    start: paging.start,
    count: paging.count,
    total: paging.total,
  }
}

/**
 * Generate a unique origin token for message deduplication.
 * Format: UUID v4-like string
 */
function generateOriginToken(): string {
  // Generate a UUID-like token
  const timestamp = Date.now().toString(16)
  const random = Math.random().toString(16).substring(2, 10)
  const random2 = Math.random().toString(16).substring(2, 10)
  return `${timestamp}-${random}-${random2}`
}

/**
 * Generate a tracking ID for the message.
 * LinkedIn uses these for analytics/tracking purposes.
 */
function generateTrackingId(): string {
  // Base64-encoded tracking ID with timestamp
  const timestamp = Date.now()
  const random = Math.floor(Math.random() * 1000000)
  const data = `${timestamp}:${random}`
  // Simple base64 encoding (browser-compatible)
  return btoa(data).replace(/=/g, '')
}
