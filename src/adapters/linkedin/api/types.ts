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

export interface Message {
  body: AttributedText;
  deliveredAt: number;
  entityURN: string;
  sender: MessagingParticipant;
  messageBodyRenderFormat: "DEFAULT" | "EDITED" | "RECALLED" | "SYSTEM";
  renderContent?: Array<Record<string, unknown>>;
  reactionSummaries?: Array<{
    emoji: string;
    count: number;
    viewerReacted: boolean;
  }>;
  conversationURN: string;
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

export interface Connection {
  profileId: string;
  profileUrl: string;
  firstName: string;
  lastName: string;
  headline?: string;
  connectionDate?: string;
  picture?: VectorImage;
}
