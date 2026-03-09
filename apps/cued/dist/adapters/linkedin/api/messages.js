import { PAGINATION_DEFAULTS } from "./constants.js";
import { linkedInEncode, newMessagingGraphQLRequest } from "./request.js";
function ensureMsgConversationURN(conversationId) {
    if (conversationId.startsWith("urn:li:msg_conversation:")) {
        return conversationId;
    }
    if (conversationId.startsWith("urn:li:fsd_conversation:")) {
        return `urn:li:msg_conversation:${conversationId.replace("urn:li:fsd_conversation:", "")}`;
    }
    return `urn:li:msg_conversation:${conversationId}`;
}
function parseRawMessage(raw, conversationURN) {
    const body = {
        text: raw.body?.text ?? "",
        attributes: raw.body?.attributes?.map((attribute) => ({ ...attribute })),
    };
    const member = raw.sender?.participantType?.member;
    const organization = raw.sender?.participantType?.organization;
    const picture = member?.picture?.url
        ? {
            url: member.picture.url,
            width: member.picture.width,
            height: member.picture.height,
        }
        : undefined;
    return {
        entityURN: raw.entityUrn ?? raw.backendUrn ?? "",
        body,
        deliveredAt: raw.deliveredAt ?? 0,
        sender: {
            entityURN: raw.sender?.entityUrn ?? "",
            participantType: {
                member: member
                    ? {
                        profileUrl: member.profileUrl ?? "",
                        firstName: member.firstName ?? "",
                        lastName: member.lastName ?? "",
                        headline: member.headline,
                        picture,
                    }
                    : undefined,
                organization: organization
                    ? {
                        name: organization.name ?? "",
                        logoUrl: organization.logoUrl,
                        pageUrl: organization.pageUrl,
                    }
                    : undefined,
            },
        },
        messageBodyRenderFormat: raw.messageBodyRenderFormat ?? "DEFAULT",
        renderContent: raw.renderContent,
        reactionSummaries: raw.reactionSummaries,
        conversationURN: raw.conversationUrn ?? raw["*conversation"] ?? conversationURN,
    };
}
function parsePagingMetadata(paging) {
    return paging
        ? {
            start: paging.start,
            count: paging.count,
            total: paging.total,
        }
        : undefined;
}
export async function getMessages(client, conversationId) {
    const conversationURN = ensureMsgConversationURN(conversationId);
    const response = await newMessagingGraphQLRequest(client.cookies, "messengerMessagesByConversation", {
        conversationUrn: linkedInEncode(conversationURN),
        count: String(PAGINATION_DEFAULTS.messagesCount),
    }).doJSON();
    const data = response.data?.messengerMessagesByConversation;
    return {
        messages: (data?.elements ?? []).map((message) => parseRawMessage(message, conversationURN)),
        metadata: parsePagingMetadata(data?.paging),
    };
}
export async function getMessagesBefore(client, conversationId, timestamp) {
    const conversationURN = ensureMsgConversationURN(conversationId);
    const response = await newMessagingGraphQLRequest(client.cookies, "messengerMessagesByAnchorTimestamp", {
        conversationUrn: linkedInEncode(conversationURN),
        deliveredAt: String(timestamp),
        countBefore: String(PAGINATION_DEFAULTS.messagesCount),
        countAfter: "0",
    }).doJSON();
    const data = response.data?.messengerMessagesByAnchorTimestamp;
    return {
        messages: (data?.elements ?? []).map((message) => parseRawMessage(message, conversationURN)),
        metadata: parsePagingMetadata(data?.paging),
    };
}
//# sourceMappingURL=messages.js.map