/**
 * LinkedIn Conversations API
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/conversations.go
 */

import type { LinkedInClient, ConversationsResult } from './client'
import type {
  Conversation,
  MessagingParticipant,
  PagingMetadata,
  VectorImage,
  AttributedText,
  Message,
  CollectionResponse,
} from './types'
import { PAGINATION_DEFAULTS } from './constants'
import { newMessagingGraphQLRequest } from './request'

// ============================================================================
// GraphQL Response Types (internal)
// ============================================================================

interface GraphQLConversationsResponse {
  data?: {
    messengerConversationsBySyncToken?: ConversationsData
    messengerConversations?: ConversationsData
  }
  included?: IncludedObject[]
}

interface ConversationsData {
  elements: RawConversation[]
  metadata?: {
    newSyncToken?: string
  }
  paging?: {
    start?: number
    count?: number
    total?: number
  }
}

interface RawConversation {
  title?: string
  entityUrn: string
  lastActivityAt: number
  lastReadAt?: number
  groupChat?: boolean
  conversationParticipants?: RawParticipant[]
  read?: boolean
  categories?: string[]
  '*messages'?: string[] // Reference to included messages
  messages?: RawMessagesCollection
}

interface RawMessagesCollection {
  elements?: RawMessage[]
  paging?: {
    start?: number
    count?: number
    total?: number
  }
}

interface RawMessage {
  body?: { text?: string; attributes?: unknown[] }
  deliveredAt?: number
  entityUrn?: string
  sender?: RawParticipant
  messageBodyRenderFormat?: string
  renderContent?: unknown[]
  reactionSummaries?: unknown[]
  '*conversationUrn'?: string
}

interface RawParticipant {
  participantType?: {
    member?: RawMemberInfo
    organization?: RawOrganizationInfo
  }
  entityUrn?: string
  hostIdentityUrn?: string
}

interface RawMemberInfo {
  profileUrl?: string
  firstName?: { text?: string }
  lastName?: { text?: string }
  headline?: { text?: string }
  picture?: RawVectorImage
}

interface RawOrganizationInfo {
  name?: { text?: string }
  logoUrl?: string
  pageUrl?: string
}

interface RawVectorImage {
  rootUrl?: string
  artifacts?: Array<{
    width?: number
    height?: number
    fileIdentifyingUrlPathSegment?: string
  }>
}

interface IncludedObject {
  $type?: string
  entityUrn?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

// ============================================================================
// Response Parsing
// ============================================================================

function parseVectorImage(raw: RawVectorImage | undefined): VectorImage | undefined {
  if (!raw?.rootUrl || !raw.artifacts?.length) {
    return undefined
  }
  // Get the largest artifact
  const artifact = raw.artifacts.reduce((a, b) =>
    (a.width ?? 0) > (b.width ?? 0) ? a : b
  )
  return {
    url: `${raw.rootUrl}${artifact.fileIdentifyingUrlPathSegment ?? ''}`,
    width: artifact.width,
    height: artifact.height,
  }
}

function parseParticipant(raw: RawParticipant | undefined): MessagingParticipant | null {
  if (!raw?.entityUrn) {
    return null
  }

  const member = raw.participantType?.member
  const org = raw.participantType?.organization

  return {
    entityURN: raw.entityUrn,
    participantType: {
      member: member
        ? {
            profileUrl: member.profileUrl ?? '',
            firstName: member.firstName?.text ?? '',
            lastName: member.lastName?.text ?? '',
            headline: member.headline?.text,
            picture: parseVectorImage(member.picture),
          }
        : undefined,
      organization: org
        ? {
            name: org.name?.text ?? '',
            logoUrl: org.logoUrl,
            pageUrl: org.pageUrl,
          }
        : undefined,
    },
  }
}

function parseMessage(raw: RawMessage): Message | null {
  if (!raw.entityUrn) {
    return null
  }

  const sender = parseParticipant(raw.sender)
  if (!sender) {
    return null
  }

  const body: AttributedText = {
    text: raw.body?.text ?? '',
    attributes: raw.body?.attributes as Message['body']['attributes'],
  }

  return {
    body,
    deliveredAt: raw.deliveredAt ?? 0,
    entityURN: raw.entityUrn,
    sender,
    messageBodyRenderFormat: (raw.messageBodyRenderFormat ?? 'DEFAULT') as Message['messageBodyRenderFormat'],
    renderContent: raw.renderContent as Message['renderContent'],
    reactionSummaries: raw.reactionSummaries as Message['reactionSummaries'],
    conversationURN: raw['*conversationUrn'] ?? '',
  }
}

function parseConversation(raw: RawConversation): Conversation {
  const participants: MessagingParticipant[] = (raw.conversationParticipants ?? [])
    .map(parseParticipant)
    .filter((p): p is MessagingParticipant => p !== null)

  // Parse embedded messages if present
  let messages: CollectionResponse<Message> | undefined
  if (raw.messages?.elements) {
    const parsedMessages = raw.messages.elements
      .map(parseMessage)
      .filter((m): m is Message => m !== null)

    messages = {
      elements: parsedMessages,
      metadata: raw.messages.paging
        ? {
            start: raw.messages.paging.start,
            count: raw.messages.paging.count,
            total: raw.messages.paging.total,
          }
        : undefined,
    }
  }

  // Calculate unread count based on read status
  // LinkedIn doesn't directly provide unreadCount, we derive it
  const unreadCount = raw.read === false ? 1 : 0

  return {
    title: raw.title ?? '',
    entityURN: raw.entityUrn,
    lastActivityAt: raw.lastActivityAt,
    lastReadAt: raw.lastReadAt ?? 0,
    groupChat: raw.groupChat ?? false,
    conversationParticipants: participants,
    read: raw.read ?? true,
    messages,
    categories: raw.categories ?? [],
    unreadCount,
  }
}

function parseConversationsResponse(response: GraphQLConversationsResponse): {
  conversations: Conversation[]
  metadata?: PagingMetadata
  syncToken?: string
} {
  // Try sync token response first, then regular response
  const data =
    response.data?.messengerConversationsBySyncToken ??
    response.data?.messengerConversations

  if (!data) {
    return { conversations: [] }
  }

  const conversations = data.elements.map(parseConversation)

  const metadata: PagingMetadata | undefined = data.paging
    ? {
        start: data.paging.start,
        count: data.paging.count,
        total: data.paging.total,
      }
    : undefined

  return {
    conversations,
    metadata,
    syncToken: data.metadata?.newSyncToken,
  }
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch conversations from the inbox.
 * Uses GraphQL query MessengerConversationsBySyncToken for efficient syncing.
 *
 * @param client - The authenticated LinkedIn client
 * @param syncToken - Optional sync token for incremental updates
 * @returns Conversations with pagination metadata and new sync token
 */
export async function getConversations(
  client: LinkedInClient,
  syncToken?: string
): Promise<ConversationsResult> {
  // Get the user's mailbox URN - required for the API
  const mailboxUrn = await client.getMailboxUrn()

  console.log('[LinkedIn Conversations] Fetching conversations:', {
    mailboxUrn: mailboxUrn.substring(0, 40) + '...',
    hasSyncToken: !!syncToken,
    hasCookies: client.cookies.length,
  })

  // Use sync token query if available, otherwise use regular query
  let queryId: 'messengerConversationsBySyncToken' | 'messengerConversations'
  let variables: Record<string, string>

  if (syncToken) {
    queryId = 'messengerConversationsBySyncToken'
    variables = {
      mailboxUrn,
      syncToken,
    }
  } else {
    // Initial fetch - only mailboxUrn, no count parameter
    queryId = 'messengerConversations'
    variables = {
      mailboxUrn,
    }
  }

  console.log('[LinkedIn Conversations] Using query:', queryId, 'variables:', Object.keys(variables))

  const request = newMessagingGraphQLRequest(client.cookies, queryId, variables)

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await request.doJSON<GraphQLConversationsResponse & { errors?: any[] }>()

    console.log('[LinkedIn Conversations] Raw response:', {
      hasData: !!response.data,
      hasSyncTokenResponse: !!response.data?.messengerConversationsBySyncToken,
      hasRegularResponse: !!response.data?.messengerConversations,
      includedCount: response.included?.length ?? 0,
      errors: response.errors,
      syncTokenData: response.data?.messengerConversationsBySyncToken,
      regularData: response.data?.messengerConversations,
    })

    const result = parseConversationsResponse(response)
    console.log('[LinkedIn Conversations] Parsed conversations:', result.conversations.length)
    return result
  } catch (error) {
    console.error('[LinkedIn Conversations] Error fetching conversations:', error)
    throw error
  }
}

/**
 * Fetch conversations before a given timestamp (for pagination).
 * Uses the lastUpdatedBefore parameter to paginate through older conversations.
 *
 * @param client - The authenticated LinkedIn client
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Conversations with pagination metadata
 */
export async function getConversationsBefore(
  client: LinkedInClient,
  timestamp: number
): Promise<ConversationsResult> {
  // Get the user's mailbox URN - required for the API
  const mailboxUrn = await client.getMailboxUrn()

  // All values must be strings for LinkedIn's API format
  const variables: Record<string, string> = {
    mailboxUrn,
    count: String(PAGINATION_DEFAULTS.conversationsCount),
    lastUpdatedBefore: String(timestamp),
    query: '(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))',
  }

  const request = newMessagingGraphQLRequest(
    client.cookies,
    'messengerConversationsByCursor',
    variables
  )

  const response = await request.doJSON<GraphQLConversationsResponse>()
  return parseConversationsResponse(response)
}
