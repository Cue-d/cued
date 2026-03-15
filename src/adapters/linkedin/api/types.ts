export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface VectorImage {
  url: string;
  width?: number;
  height?: number;
}

export interface MemberParticipantInfo {
  profileUrl: string;
  firstName: string;
  lastName: string;
  headline?: string;
  picture?: VectorImage;
}

export interface OrganizationParticipantInfo {
  name: string;
  logoUrl?: string;
  pageUrl?: string;
}

export interface ParticipantType {
  member?: MemberParticipantInfo;
  organization?: OrganizationParticipantInfo;
}

export interface MessagingParticipant {
  participantType: ParticipantType;
  entityURN: string;
}

export interface PagingMetadata {
  start?: number;
  count?: number;
  total?: number;
}

export interface AttributedText {
  text: string;
  attributes?: Array<Record<string, unknown>>;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  viewerReacted: boolean;
  firstReactedAt?: number;
}

export interface RepliedMessageContent {
  originalMessage?: {
    entityUrn?: string;
    deliveredAt?: number;
    body?: { text?: string };
    sender?: { entityUrn?: string };
  };
}

export interface RenderContentItem {
  repliedMessageContent?: RepliedMessageContent;
  file?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  vectorImage?: Record<string, unknown>;
  externalMedia?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Message {
  body: AttributedText;
  deliveredAt: number;
  entityURN: string;
  sender: MessagingParticipant;
  messageBodyRenderFormat: "DEFAULT" | "EDITED" | "RECALLED" | "SYSTEM";
  renderContent?: RenderContentItem[];
  reactionSummaries?: ReactionSummary[];
  conversationURN: string;
  conversation?: Conversation;
}

export interface CollectionResponse<T> {
  metadata?: PagingMetadata;
  elements: T[];
}

export interface Conversation {
  title: string;
  entityURN: string;
  lastActivityAt: number;
  lastReadAt: number;
  groupChat: boolean;
  conversationParticipants: MessagingParticipant[];
  read: boolean;
  messages?: CollectionResponse<Message>;
  categories: string[];
  unreadCount?: number;
}

export interface SeenReceipt {
  seenAt: number;
  message: Message;
  seenByParticipant: MessagingParticipant;
}

export interface RealtimeReaction {
  reactionAdded: boolean;
  actor: MessagingParticipant;
  message: Message;
  reactionSummary: ReactionSummary;
}

export interface RealtimeDecoratedEvent {
  topic: string;
  leftServerAt: number;
  id: string;
  payload: {
    data: {
      _type?: string;
      doDecorateConversationMessengerRealtimeDecoration?: { result: Conversation };
      doDecorateConversationDeleteMessengerRealtimeDecoration?: { result: Conversation };
      doDecorateMessageMessengerRealtimeDecoration?: { result: Message };
      doDecorateSeenReceiptMessengerRealtimeDecoration?: { result: SeenReceipt };
      doDecorateRealtimeReactionSummaryMessengerRealtimeDecoration?: {
        result: RealtimeReaction;
      };
    };
  };
}

export interface RealtimeEventEnvelope {
  "com.linkedin.realtimefrontend.Heartbeat"?: Record<string, never>;
  "com.linkedin.realtimefrontend.ClientConnection"?: {
    id?: string;
  };
  "com.linkedin.realtimefrontend.DecoratedEvent"?: RealtimeDecoratedEvent;
}

export interface Connection {
  profileId: string;
  profileUrl: string;
  firstName: string;
  lastName: string;
  headline?: string;
  connectionDate?: string;
  picture?: VectorImage;
}
