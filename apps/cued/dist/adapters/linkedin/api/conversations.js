import { PAGINATION_DEFAULTS } from "./constants.js";
import { newMessagingGraphQLRequest } from "./request.js";
function parseVectorImage(raw) {
    if (!raw?.rootUrl || !raw.artifacts?.length) {
        return undefined;
    }
    const artifact = raw.artifacts.reduce((left, right) => (left.width ?? 0) > (right.width ?? 0) ? left : right);
    return {
        url: `${raw.rootUrl}${artifact.fileIdentifyingUrlPathSegment ?? ""}`,
        width: artifact.width,
        height: artifact.height,
    };
}
function parseParticipant(raw) {
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
function parseMessage(raw) {
    if (!raw.entityUrn) {
        return null;
    }
    const sender = parseParticipant(raw.sender);
    if (!sender) {
        return null;
    }
    const body = {
        text: raw.body?.text ?? "",
        attributes: raw.body?.attributes,
    };
    return {
        body,
        deliveredAt: raw.deliveredAt ?? 0,
        entityURN: raw.entityUrn,
        sender,
        messageBodyRenderFormat: (raw.messageBodyRenderFormat ?? "DEFAULT"),
        renderContent: raw.renderContent,
        reactionSummaries: raw.reactionSummaries,
        conversationURN: raw["*conversationUrn"] ?? "",
    };
}
function parseConversation(raw) {
    const participants = (raw.conversationParticipants ?? [])
        .map(parseParticipant)
        .filter((participant) => participant !== null);
    let messages;
    if (raw.messages?.elements) {
        messages = {
            elements: raw.messages.elements
                .map(parseMessage)
                .filter((message) => message !== null),
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
function parseConversationsResponse(response) {
    const data = response.data?.messengerConversationsBySyncToken ?? response.data?.messengerConversations;
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
    };
}
export async function getConversations(client, syncToken) {
    const mailboxUrn = await client.getMailboxUrn();
    const queryId = syncToken ? "messengerConversationsBySyncToken" : "messengerConversations";
    const variables = syncToken
        ? { mailboxUrn, syncToken }
        : { mailboxUrn };
    const response = await newMessagingGraphQLRequest(client.cookies, queryId, variables)
        .doJSON();
    return parseConversationsResponse(response);
}
export async function getConversationsBefore(client, timestamp) {
    const mailboxUrn = await client.getMailboxUrn();
    const variables = {
        mailboxUrn,
        count: String(PAGINATION_DEFAULTS.conversationsCount),
        lastUpdatedBefore: String(timestamp),
        query: "(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))",
    };
    const response = await newMessagingGraphQLRequest(client.cookies, "messengerConversationsByCursor", variables).doJSON();
    return parseConversationsResponse(response);
}
//# sourceMappingURL=conversations.js.map