/**
 * LinkedIn API Types
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/tree/main/pkg/linkedingo
 */

// ============================================================================
// Cookie Types
// ============================================================================

export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

// ============================================================================
// URN Types (LinkedIn Universal Resource Names)
// ============================================================================

export interface URNData {
  prefix: string
  id: string
}

// ============================================================================
// Participant Types
// ============================================================================

export interface MemberParticipantInfo {
  profileUrl: string
  firstName: string
  lastName: string
  headline?: string
  picture?: VectorImage
}

export interface OrganizationParticipantInfo {
  name: string
  logoUrl?: string
  pageUrl?: string
}

export interface ParticipantType {
  member?: MemberParticipantInfo
  organization?: OrganizationParticipantInfo
}

export interface MessagingParticipant {
  participantType: ParticipantType
  entityURN: string
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface Conversation {
  title: string
  entityURN: string
  lastActivityAt: number // Unix milliseconds
  lastReadAt: number // Unix milliseconds
  groupChat: boolean
  conversationParticipants: MessagingParticipant[]
  read: boolean
  messages?: CollectionResponse<Message>
  categories: string[]
  unreadCount?: number
}

export interface CollectionResponse<T> {
  metadata?: PagingMetadata
  elements: T[]
}

export interface PagingMetadata {
  start?: number
  count?: number
  total?: number
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageBodyRenderFormat = 'DEFAULT' | 'EDITED' | 'RECALLED' | 'SYSTEM'

export interface Message {
  body: AttributedText
  deliveredAt: number // Unix milliseconds
  entityURN: string
  sender: MessagingParticipant
  messageBodyRenderFormat: MessageBodyRenderFormat
  renderContent?: RenderContent[]
  reactionSummaries?: ReactionSummary[]
  conversationURN: string
}

export interface AttributedText {
  text: string
  attributes?: TextAttribute[]
}

export interface TextAttribute {
  start: number
  length: number
  type: string
  // Additional type-specific fields
  [key: string]: unknown
}

// ============================================================================
// Render Content (Attachments)
// ============================================================================

export interface RenderContent {
  audio?: AudioMetadata
  file?: FileAttachment
  video?: VideoPlayMetadata
  image?: VectorImage
  externalMedia?: ExternalMedia
  forwardedMessage?: ForwardedMessage
  repliedMessage?: RepliedMessage
}

export interface AudioMetadata {
  url: string
  duration?: number
}

export interface FileAttachment {
  name: string
  url: string
  mediaType?: string
  size?: number
}

export interface VideoPlayMetadata {
  url: string
  thumbnail?: VectorImage
  duration?: number
}

export interface VectorImage {
  url: string
  width?: number
  height?: number
}

export interface ExternalMedia {
  url: string
  title?: string
  description?: string
  previewImage?: VectorImage
}

export interface ForwardedMessage {
  originalMessageURN: string
  originalSender?: MessagingParticipant
}

export interface RepliedMessage {
  originalMessageURN: string
  originalSender?: MessagingParticipant
  originalBody?: AttributedText
}

export interface ReactionSummary {
  emoji: string
  count: number
  viewerReacted: boolean
}

// ============================================================================
// Connection Types
// ============================================================================

export interface Connection {
  profileId: string
  profileUrl: string
  firstName: string
  lastName: string
  headline?: string
  connectionDate?: string
  picture?: VectorImage
}

// ============================================================================
// Send Message Types
// ============================================================================

export interface SendMessagePayload {
  conversationURN: string
  body: string
  renderContent?: SendRenderContent[]
  originToken?: string // For deduplication
}

export interface SendRenderContent {
  audio?: AudioMetadata
  file?: FileAttachment
  video?: VideoPlayMetadata
  repliedMessageURN?: string
}

// ============================================================================
// API Response Types
// ============================================================================

export interface GraphQLResponse<T> {
  data?: T
  errors?: GraphQLError[]
}

export interface GraphQLError {
  message: string
  locations?: Array<{ line: number; column: number }>
  path?: string[]
  extensions?: Record<string, unknown>
}

export interface ConversationsResponse {
  messengerConversationsBySyncToken?: {
    elements: Conversation[]
    metadata?: PagingMetadata
  }
}

export interface MessagesResponse {
  messengerMessagesByConversation?: {
    elements: Message[]
    metadata?: PagingMetadata
  }
}

// ============================================================================
// Client Configuration Types
// ============================================================================

export interface LinkedInClientConfig {
  cookies: Cookie[]
  userAgent?: string
}

export interface AuthState {
  isAuthenticated: boolean
  userEntityURN?: string
}

// ============================================================================
// Event Handler Types
// ============================================================================

export interface EventHandlers {
  onHeartbeat?: () => void
  onConnected?: () => void
  onDisconnected?: (error?: Error) => void
  onCredentialFailure?: (error: Error) => void
  onMessage?: (message: Message) => void
  onConversationUpdate?: (conversation: Conversation) => void
  onTypingIndicator?: (conversationURN: string, participant: MessagingParticipant) => void
}
