import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConversationType, parsePlatform, } from "../types/provider.js";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const DEFAULT_AGENT_REPLICA_DB_PATH = join(homedir(), ".cued", "agent-replica.db");
const DEFAULT_MESSAGE_LIMIT = 2_000;
function dedupeKey(seed) {
    return createHash("sha256").update(seed).digest("hex");
}
function parseJsonArray(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function isDeterministicHandle(platform, type, value) {
    if (!value.trim()) {
        return false;
    }
    if (type === "phone" || type === "email" || type === "slack_id") {
        return true;
    }
    if (platform === "linkedin" && (type === "urn" || type === "linkedin_urn")) {
        return true;
    }
    if (platform === "twitter" && (type === "twitter_user_id" || type === "user_id")) {
        return true;
    }
    return false;
}
function normalizeMessageStatus(message) {
    if (message.status) {
        return message.status;
    }
    return message.is_from_me === 1 ? "sent" : "delivered";
}
function sourceAccountKeyForPlatform(platform, workspaceId) {
    return workspaceId ? `${platform}:${workspaceId}` : platform;
}
function resolveLegacyPlatform(platform) {
    return parsePlatform(platform.trim().toLowerCase());
}
function parseUsageKey(usageKey) {
    const separator = usageKey.indexOf("::");
    if (separator < 0) {
        return {
            platform: resolveLegacyPlatform(usageKey),
            accountKey: usageKey,
        };
    }
    return {
        platform: resolveLegacyPlatform(usageKey.slice(0, separator)),
        accountKey: usageKey.slice(separator + 2),
    };
}
export function buildAgentReplicaSyncBundle(options) {
    const dbPath = options?.path ?? process.env.CUED_AGENT_REPLICA_DB_PATH ?? DEFAULT_AGENT_REPLICA_DB_PATH;
    const messageLimit = options?.messageLimit ?? Number(process.env.CUED_AGENT_REPLICA_MESSAGE_LIMIT ?? DEFAULT_MESSAGE_LIMIT);
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
        const messages = db
            .prepare(`SELECT
           id,
           conversation_id,
           conversation_name,
           platform,
           content,
           sent_at,
           sender_contact_id,
           sender_name,
           is_from_me,
           status,
           reactions_json
         FROM messages
         ORDER BY sent_at DESC
         LIMIT ?`)
            .all(messageLimit);
        const orderedMessages = [...messages].reverse();
        const conversationIds = [...new Set(orderedMessages.map((message) => message.conversation_id))];
        const conversations = conversationIds.length
            ? db
                .prepare(`SELECT
               id,
               platform,
               platform_conversation_id,
               conversation_type,
               display_name,
               participant_contact_ids_json,
               participant_names_json,
               workspace_id
             FROM conversations
             WHERE id IN (SELECT value FROM json_each(?))`)
                .all(JSON.stringify(conversationIds))
            : [];
        const referencedContactIds = new Set();
        for (const message of orderedMessages) {
            if (message.sender_contact_id) {
                referencedContactIds.add(message.sender_contact_id);
            }
        }
        for (const conversation of conversations) {
            for (const contactId of parseJsonArray(conversation.participant_contact_ids_json)) {
                referencedContactIds.add(contactId);
            }
        }
        const contacts = referencedContactIds.size > 0
            ? db
                .prepare(`SELECT
               id,
               display_name,
               company,
               handles_json
             FROM contacts
             WHERE id IN (SELECT value FROM json_each(?))`)
                .all(JSON.stringify([...referencedContactIds]))
            : [];
        const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
        const contactUsageScopes = new Map();
        const contactNameHints = new Map();
        const observedBase = Date.now();
        const sourceAccounts = new Map();
        const rawEvents = [];
        for (const conversation of conversations) {
            const platform = resolveLegacyPlatform(conversation.platform);
            if (!platform) {
                continue;
            }
            const accountKey = sourceAccountKeyForPlatform(conversation.platform, conversation.workspace_id);
            sourceAccounts.set(`${platform}:${accountKey}`, {
                platform,
                accountKey,
                displayName: conversation.workspace_id
                    ? `${platform} ${conversation.workspace_id}`
                    : `legacy ${platform}`,
            });
            const participantIds = parseJsonArray(conversation.participant_contact_ids_json);
            const participantNames = parseJsonArray(conversation.participant_names_json);
            for (const [index, contactId] of participantIds.entries()) {
                if (!contactUsageScopes.has(contactId)) {
                    contactUsageScopes.set(contactId, new Set());
                }
                contactUsageScopes.get(contactId).add(`${conversation.platform}::${accountKey}`);
                const nameHint = participantNames[index];
                if (nameHint && !contactNameHints.has(contactId)) {
                    contactNameHints.set(contactId, nameHint);
                }
            }
        }
        for (const message of orderedMessages) {
            if (message.sender_contact_id) {
                const conversation = conversationById.get(message.conversation_id);
                const accountKey = sourceAccountKeyForPlatform(message.platform, conversation?.workspace_id ?? null);
                if (!contactUsageScopes.has(message.sender_contact_id)) {
                    contactUsageScopes.set(message.sender_contact_id, new Set());
                }
                contactUsageScopes.get(message.sender_contact_id).add(`${message.platform}::${accountKey}`);
                if (message.sender_name && !contactNameHints.has(message.sender_contact_id)) {
                    contactNameHints.set(message.sender_contact_id, message.sender_name);
                }
            }
        }
        const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
        for (const contactId of referencedContactIds) {
            if (!contactsById.has(contactId)) {
                contactsById.set(contactId, {
                    id: contactId,
                    display_name: contactNameHints.get(contactId) ?? contactId,
                    company: null,
                    handles_json: "[]",
                });
            }
        }
        let contactObservedAt = observedBase;
        for (const contact of contactsById.values()) {
            const handles = parseJsonArray(contact.handles_json).filter((handle) => Boolean(handle.platform && handle.type && handle.value));
            const groupedByScope = new Map();
            for (const handle of handles) {
                const scopeKey = `${handle.platform}::${handle.platform}`;
                if (!groupedByScope.has(scopeKey)) {
                    groupedByScope.set(scopeKey, []);
                }
                groupedByScope.get(scopeKey).push(handle);
            }
            for (const usageKey of contactUsageScopes.get(contact.id) ?? []) {
                if (!groupedByScope.has(usageKey)) {
                    groupedByScope.set(usageKey, []);
                }
            }
            if (groupedByScope.size === 0) {
                groupedByScope.set("legacy::legacy", []);
            }
            for (const [usageKey, scopeHandles] of groupedByScope.entries()) {
                const { platform, accountKey } = parseUsageKey(usageKey);
                if (!platform) {
                    continue;
                }
                const platformHandles = scopeHandles.filter((handle) => handle.platform === platform);
                sourceAccounts.set(`${platform}:${accountKey}`, {
                    platform,
                    accountKey,
                    displayName: accountKey === platform ? `legacy ${platform}` : `legacy ${accountKey}`,
                });
                rawEvents.push({
                    id: randomUUID(),
                    platform,
                    accountKey,
                    entityKind: "contact",
                    eventKind: "observed",
                    externalEntityId: contact.id,
                    observedAt: contactObservedAt,
                    dedupeKey: dedupeKey(`agent-replica:contact:${platform}:${accountKey}:${contact.id}`),
                    payload: {
                        sourceEntityKey: `legacy_contact:${contact.id}`,
                        fields: {
                            display_name: contact.display_name,
                            company: contact.company,
                        },
                        handles: platformHandles.map((handle) => ({
                            type: handle.type,
                            value: handle.value,
                            deterministic: isDeterministicHandle(handle.platform, handle.type, handle.value),
                        })),
                    },
                    sourceVersion: "agent-replica-v1",
                });
                contactObservedAt += 1;
            }
        }
        let conversationObservedAt = observedBase + 1_000_000;
        for (const conversation of conversations) {
            const platform = resolveLegacyPlatform(conversation.platform);
            if (!platform) {
                continue;
            }
            const accountKey = sourceAccountKeyForPlatform(conversation.platform, conversation.workspace_id);
            rawEvents.push({
                id: randomUUID(),
                platform,
                accountKey,
                entityKind: "conversation",
                eventKind: "observed",
                externalEntityId: conversation.id,
                conversationExternalId: conversation.id,
                observedAt: conversationObservedAt,
                dedupeKey: dedupeKey(`agent-replica:conversation:${platform}:${conversation.id}`),
                payload: {
                    sourceConversationKey: conversation.id,
                    originalConversationKey: conversation.platform_conversation_id,
                    conversationType: parseConversationType(conversation.conversation_type),
                    displayName: conversation.display_name,
                    participants: parseJsonArray(conversation.participant_contact_ids_json).map((contactId) => ({
                        sourceEntityKey: `legacy_contact:${contactId}`,
                    })),
                },
                sourceVersion: "agent-replica-v1",
            });
            conversationObservedAt += 1;
        }
        let messageObservedAt = observedBase + 2_000_000;
        for (const [index, message] of orderedMessages.entries()) {
            const platform = resolveLegacyPlatform(message.platform);
            if (!platform) {
                continue;
            }
            const conversation = conversationById.get(message.conversation_id);
            const accountKey = sourceAccountKeyForPlatform(message.platform, conversation?.workspace_id ?? null);
            sourceAccounts.set(`${platform}:${accountKey}`, {
                platform,
                accountKey,
                displayName: conversation?.workspace_id
                    ? `${platform} ${conversation.workspace_id}`
                    : `legacy ${platform}`,
            });
            rawEvents.push({
                id: randomUUID(),
                platform,
                accountKey,
                entityKind: "message",
                eventKind: "message_created",
                externalEntityId: message.id,
                conversationExternalId: message.conversation_id,
                occurredAt: message.sent_at,
                observedAt: messageObservedAt,
                dedupeKey: dedupeKey(`agent-replica:message:${platform}:${message.id}`),
                payload: {
                    sourceMessageKey: message.id,
                    sourceConversationKey: message.conversation_id,
                    senderSourceKey: message.sender_contact_id ? `legacy_contact:${message.sender_contact_id}` : null,
                    sentAt: message.sent_at,
                    contentOriginal: message.content,
                    contentCurrent: message.content,
                    statusDelivery: normalizeMessageStatus(message),
                    readAt: null,
                    isEdited: false,
                    isDeleted: false,
                    hasAttachments: false,
                    attachments: [],
                    legacyConversationName: message.conversation_name,
                    legacySenderName: message.sender_name,
                },
                sourceVersion: "agent-replica-v1",
            });
            messageObservedAt += 1;
            const reactions = parseJsonArray(message.reactions_json);
            let reactionObservedAt = observedBase + 3_000_000 + index * 100;
            for (const [reactionIndex, reaction] of reactions.entries()) {
                rawEvents.push({
                    id: randomUUID(),
                    platform,
                    accountKey,
                    entityKind: "reaction",
                    eventKind: "reaction_added",
                    externalEntityId: `${message.id}:${reactionIndex}`,
                    conversationExternalId: message.conversation_id,
                    occurredAt: reaction.timestamp ?? message.sent_at,
                    observedAt: reactionObservedAt,
                    dedupeKey: dedupeKey(`agent-replica:reaction:${platform}:${message.id}:${reactionIndex}`),
                    payload: {
                        sourceMessageKey: message.id,
                        sourceConversationKey: message.conversation_id,
                        reactorSourceKey: reaction.isFromMe ? null : message.sender_contact_id ? `legacy_contact:${message.sender_contact_id}` : null,
                        emoji: reaction.emoji ?? "",
                        timestamp: reaction.timestamp ?? message.sent_at,
                        isActive: true,
                    },
                    sourceVersion: "agent-replica-v1",
                });
                reactionObservedAt += 1;
            }
        }
        return {
            sourceAccounts: [...sourceAccounts.values()],
            rawEvents,
            sourceCursor: {
                importedMessages: orderedMessages.length,
                importedAt: observedBase,
                sourcePath: dbPath,
            },
            syncMode: "full",
        };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=agent-replica-worker-lib.js.map