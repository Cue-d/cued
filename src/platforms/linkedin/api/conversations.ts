import type { ConversationsResult, LinkedInClient } from "./client.js";
import { PAGINATION_DEFAULTS } from "./constants.js";
import { newMessagingGraphQLRequest } from "./request.js";
import type {
  AttributedText,
  CollectionResponse,
  Conversation,
  Message,
  MessagingParticipant,
  VectorImage,
} from "./types.js";

interface GraphQLConversationsResponse {
  data?: {
    messengerConversationsBySyncToken?: ConversationsData;
    messengerConversations?: ConversationsData;
    messengerConversationsByCategoryQuery?: ConversationsData;
  };
}

interface ConversationsData {
  elements: RawConversation[];
  metadata?: {
    newSyncToken?: string;
    deletedUrns?: Array<{
      conversation?: { entityUrn?: string };
    }>;
  };
  paging?: { start?: number; count?: number; total?: number };
}

interface RawConversation {
  title?: string;
  entityUrn: string;
  lastActivityAt: number;
  lastReadAt?: number;
  groupChat?: boolean;
  conversationParticipants?: RawParticipant[];
  read?: boolean;
  categories?: string[];
  messages?: {
    elements?: RawMessage[];
    paging?: { start?: number; count?: number; total?: number };
  };
}

interface RawMessage {
  body?: { text?: string; attributes?: unknown[] };
  deliveredAt?: number;
  entityUrn?: string;
  sender?: RawParticipant;
  messageBodyRenderFormat?: string;
  renderContent?: Array<Record<string, unknown>>;
  reactionSummaries?: Array<{ emoji: string; count: number; viewerReacted: boolean }>;
  "*conversationUrn"?: string;
}

interface RawParticipant {
  participantType?: {
    member?: {
      profileUrl?: string;
      firstName?: { text?: string };
      lastName?: { text?: string };
      headline?: { text?: string };
      picture?: RawVectorImage;
    };
    organization?: {
      name?: { text?: string };
      logoUrl?: string;
      pageUrl?: string;
    };
  };
  entityUrn?: string;
}

interface RawVectorImage {
  rootUrl?: string;
  artifacts?: Array<{
    width?: number;
    height?: number;
    fileIdentifyingUrlPathSegment?: string;
  }>;
}

function parseVectorImage(raw: RawVectorImage | undefined): VectorImage | undefined {
  if (!raw?.rootUrl || !raw.artifacts?.length) {
    return undefined;
  }
  const artifact = raw.artifacts.reduce((left, right) =>
    (left.width ?? 0) > (right.width ?? 0) ? left : right,
  );
  return {
    url: `${raw.rootUrl}${artifact.fileIdentifyingUrlPathSegment ?? ""}`,
    width: artifact.width,
    height: artifact.height,
  };
}

function parseParticipant(raw: RawParticipant | undefined): MessagingParticipant | null {
  if (!raw?.entityUrn) {
    return null;
  }

  return {
    entityURN: raw.entityUrn,
    participantType: {
      member: raw.participantType?.member
        ? {
            profileUrl: raw.participantType.member.profileUrl ?? "",
            firstName: raw.participantType.member.firstName?.text ?? "",
            lastName: raw.participantType.member.lastName?.text ?? "",
            headline: raw.participantType.member.headline?.text,
            picture: parseVectorImage(raw.participantType.member.picture),
          }
        : undefined,
      organization: raw.participantType?.organization
        ? {
            name: raw.participantType.organization.name?.text ?? "",
            logoUrl: raw.participantType.organization.logoUrl,
            pageUrl: raw.participantType.organization.pageUrl,
          }
        : undefined,
    },
  };
}

function parseMessage(raw: RawMessage): Message | null {
  if (!raw.entityUrn) {
    return null;
  }
  const sender = parseParticipant(raw.sender);
  if (!sender) {
    return null;
  }

  const body: AttributedText = {
    text: raw.body?.text ?? "",
    attributes: raw.body?.attributes as AttributedText["attributes"],
  };

  return {
    body,
    deliveredAt: raw.deliveredAt ?? 0,
    entityURN: raw.entityUrn,
    sender,
    messageBodyRenderFormat: (raw.messageBodyRenderFormat ??
      "DEFAULT") as Message["messageBodyRenderFormat"],
    renderContent: raw.renderContent,
    reactionSummaries: raw.reactionSummaries,
    conversationURN: raw["*conversationUrn"] ?? "",
  };
}

function parseConversation(raw: RawConversation): Conversation {
  const participants = (raw.conversationParticipants ?? [])
    .map(parseParticipant)
    .filter((participant): participant is MessagingParticipant => participant !== null);

  let messages: CollectionResponse<Message> | undefined;
  if (raw.messages?.elements) {
    messages = {
      elements: raw.messages.elements
        .map(parseMessage)
        .filter((message): message is Message => message !== null),
      metadata: raw.messages.paging
        ? {
            start: raw.messages.paging.start,
            count: raw.messages.paging.count,
            total: raw.messages.paging.total,
          }
        : undefined,
    };
  }

  return {
    title: raw.title ?? "",
    entityURN: raw.entityUrn,
    lastActivityAt: raw.lastActivityAt,
    lastReadAt: raw.lastReadAt ?? 0,
    groupChat: raw.groupChat ?? false,
    conversationParticipants: participants,
    read: raw.read ?? true,
    messages,
    categories: raw.categories ?? [],
    unreadCount: raw.read === false ? 1 : 0,
  };
}

function parseConversationsResponse(response: GraphQLConversationsResponse): ConversationsResult {
  const data =
    response.data?.messengerConversationsBySyncToken ??
    response.data?.messengerConversations ??
    response.data?.messengerConversationsByCategoryQuery;

  if (!data) {
    return { conversations: [] };
  }

  return {
    conversations: data.elements.map(parseConversation),
    metadata: data.paging
      ? {
          start: data.paging.start,
          count: data.paging.count,
          total: data.paging.total,
        }
      : undefined,
    syncToken: data.metadata?.newSyncToken,
    nextCursor:
      data.metadata && "nextCursor" in data.metadata && typeof data.metadata.nextCursor === "string"
        ? data.metadata.nextCursor
        : null,
    deletedConversationURNs:
      data.metadata?.deletedUrns
        ?.map((item) => item.conversation?.entityUrn)
        .filter((urn): urn is string => typeof urn === "string" && urn.length > 0) ?? [],
  };
}

export async function getConversations(
  client: LinkedInClient,
  syncToken?: string,
): Promise<ConversationsResult> {
  const mailboxUrn = await client.getMailboxUrn();
  const queryId = syncToken ? "messengerConversationsBySyncToken" : "messengerConversations";
  const variables: Record<string, string> = syncToken ? { mailboxUrn, syncToken } : { mailboxUrn };
  const response = await newMessagingGraphQLRequest(client.cookies, queryId, variables, {
    pageInstance: client.pageInstance,
    xLiTrack: client.xLiTrack,
    allowRedirects: false,
  }).doJSON<GraphQLConversationsResponse>();
  return parseConversationsResponse(response);
}

export async function getConversationsBefore(
  client: LinkedInClient,
  timestamp: number,
): Promise<ConversationsResult> {
  const mailboxUrn = await client.getMailboxUrn();
  const variables = {
    mailboxUrn,
    count: String(PAGINATION_DEFAULTS.conversationsCount),
    lastUpdatedBefore: String(timestamp),
    query: "(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))",
  };
  const response = await newMessagingGraphQLRequest(
    client.cookies,
    "messengerConversationsByCursor",
    variables,
    {
      pageInstance: client.pageInstance,
      xLiTrack: client.xLiTrack,
      allowRedirects: false,
    },
  ).doJSON<GraphQLConversationsResponse>();
  return parseConversationsResponse(response);
}

export async function getConversationsWithCursor(
  client: LinkedInClient,
  nextCursor: string,
): Promise<ConversationsResult> {
  const mailboxUrn = await client.getMailboxUrn();
  const variables = {
    mailboxUrn,
    count: String(PAGINATION_DEFAULTS.conversationsCount),
    nextCursor,
    query: "(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))",
  };
  const response = await newMessagingGraphQLRequest(
    client.cookies,
    "messengerConversationsByCursor",
    variables,
    {
      pageInstance: client.pageInstance,
      xLiTrack: client.xLiTrack,
      allowRedirects: false,
    },
  ).doJSON<GraphQLConversationsResponse>();
  return parseConversationsResponse(response);
}
