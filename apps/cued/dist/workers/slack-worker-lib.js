import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openCuedDatabase } from "../db/database.js";
import { SlackClient, } from "../adapters/slack/api/index.js";
const DEFAULT_SYNC_HISTORY_DAYS = Number(process.env.CUED_SYNC_HISTORY_DAYS ?? "730");
const INCREMENTAL_BUFFER_MS = 5 * 60 * 1000;
function now() {
    return Date.now();
}
function dedupeKey(seed) {
    return createHash("sha256").update(seed).digest("hex");
}
function slackSourceKey(teamId, userId) {
    return `slack:${teamId}:${userId}`;
}
function timestampMs(slackTs) {
    if (!slackTs)
        return null;
    const parsed = Number(slackTs);
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
}
function getOldestMessageMs(lastSyncAt) {
    if (lastSyncAt && lastSyncAt > 0) {
        return Math.max(0, lastSyncAt - INCREMENTAL_BUFFER_MS);
    }
    return now() - DEFAULT_SYNC_HISTORY_DAYS * 24 * 60 * 60 * 1000;
}
function bestSlackAvatar(profile) {
    return profile.image_original || profile.image_512 || profile.image_192 || profile.image_72;
}
function toAttachmentMetadata(message) {
    const attachments = [];
    for (const file of message.files ?? []) {
        attachments.push({
            kind: "file",
            id: file.id,
            name: file.name,
            mimetype: file.mimetype ?? null,
            prettyType: file.pretty_type ?? null,
            url: file.url_private_download ?? file.url_private ?? null,
            previewUrl: file.thumb_480 ?? file.thumb_360 ?? null,
        });
    }
    for (const attachment of message.attachments ?? []) {
        attachments.push({
            kind: "attachment",
            title: attachment.title ?? null,
            text: attachment.text ?? attachment.fallback ?? null,
            url: attachment.title_link ?? attachment.image_url ?? attachment.thumb_url ?? null,
        });
    }
    return attachments;
}
function buildConversationDisplayName(conversation, usersById) {
    if (conversation.is_im && conversation.user) {
        const user = usersById.get(conversation.user);
        if (user) {
            return user.real_name || user.profile.real_name || user.profile.display_name || user.name;
        }
    }
    return conversation.name
        || conversation.topic?.value
        || conversation.purpose?.value
        || conversation.id;
}
function shouldIncludeMessage(message) {
    if (message.subtype === "channel_join" || message.subtype === "channel_leave") {
        return false;
    }
    return Boolean(message.text
        || (message.files && message.files.length > 0)
        || (message.attachments && message.attachments.length > 0));
}
function loadSlackAuthFromKeychain(accountKey) {
    const db = openCuedDatabase();
    try {
        const integration = db.getIntegrationState("slack", accountKey);
        if (!integration?.metadata_json) {
            throw new Error(`Slack integration not found or not authenticated for account '${accountKey}'`);
        }
        const metadata = JSON.parse(integration.metadata_json);
        const keychainService = typeof metadata.keychainService === "string" ? metadata.keychainService : null;
        const keychainAccount = typeof metadata.keychainAccount === "string" ? metadata.keychainAccount : null;
        if (!keychainService || !keychainAccount) {
            throw new Error(`Slack integration '${accountKey}' does not have stored Keychain credentials`);
        }
        const stdout = execFileSync("security", ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const parsed = JSON.parse(stdout);
        if (typeof parsed.token !== "string" || typeof parsed.cookie !== "string") {
            throw new Error(`Slack Keychain payload for '${accountKey}' is missing token or cookie`);
        }
        return {
            credentials: {
                token: parsed.token,
                cookie: parsed.cookie,
            },
            keychainService,
            keychainAccount,
        };
    }
    finally {
        db.close();
    }
}
async function listAllUsers(client) {
    const users = [];
    let cursor;
    do {
        const result = await client.listUsers(cursor);
        users.push(...result.users.filter((user) => !user.deleted));
        cursor = result.nextCursor || undefined;
    } while (cursor);
    return users;
}
async function listAllConversations(client) {
    const conversations = [];
    let cursor;
    do {
        const result = await client.listConversations(cursor);
        conversations.push(...result.conversations);
        cursor = result.nextCursor || undefined;
    } while (cursor);
    return conversations;
}
async function listConversationMembers(client, conversation) {
    if (conversation.is_im && conversation.user) {
        return [conversation.user];
    }
    const members = [];
    let cursor;
    do {
        const result = await client.getConversationMembers(conversation.id, cursor);
        members.push(...result.members);
        cursor = result.nextCursor || undefined;
    } while (cursor);
    return [...new Set(members)];
}
async function listConversationMessages(client, conversationId, oldestMs) {
    const messages = [];
    let cursor;
    do {
        const result = await client.getHistory(conversationId, {
            cursor,
            oldest: (oldestMs / 1000).toFixed(6),
        });
        messages.push(...result.messages.filter(shouldIncludeMessage));
        cursor = result.nextCursor || undefined;
    } while (cursor);
    return messages;
}
export async function buildSlackSyncBundle(options) {
    const accountKey = options?.accountKey ?? process.env.CUED_ACCOUNT_KEY ?? "default";
    const loadedAuth = options?.client ? null : loadSlackAuthFromKeychain(accountKey);
    const client = options?.client ?? new SlackClient(loadedAuth.credentials);
    const auth = await client.testAuth();
    if (!auth.ok || !auth.team_id || !auth.user_id) {
        throw new Error(`Slack auth test failed for '${accountKey}': ${auth.error ?? "unknown_error"}`);
    }
    const teamId = auth.team_id;
    const teamName = auth.team ?? teamId;
    const selfUserId = auth.user_id;
    const observedBase = now();
    const oldestMs = getOldestMessageMs(options?.lastSyncAt);
    const users = await listAllUsers(client);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const conversations = await listAllConversations(client);
    const sourceAccounts = [
        {
            platform: "slack",
            accountKey,
            displayName: teamName,
        },
    ];
    const rawEvents = [];
    for (const user of users) {
        rawEvents.push({
            id: randomUUID(),
            platform: "slack",
            accountKey,
            entityKind: "contact",
            eventKind: "observed",
            externalEntityId: user.id,
            observedAt: observedBase,
            dedupeKey: dedupeKey(`slack:contact:${teamId}:${user.id}`),
            payload: {
                sourceEntityKey: slackSourceKey(teamId, user.id),
                fields: {
                    display_name: user.real_name || user.profile.real_name || user.profile.display_name || user.name,
                    photo_url: bestSlackAvatar(user.profile) ?? null,
                },
                handles: [
                    {
                        type: "slack_user_id",
                        value: `${teamId}:${user.id}`,
                        deterministic: true,
                    },
                    ...(user.profile.email ? [{
                            type: "email",
                            value: user.profile.email,
                            deterministic: true,
                        }] : []),
                ],
            },
            sourceVersion: "slack-v1",
        });
    }
    for (const conversation of conversations) {
        const memberIds = await listConversationMembers(client, conversation);
        rawEvents.push({
            id: randomUUID(),
            platform: "slack",
            accountKey,
            entityKind: "conversation",
            eventKind: "observed",
            conversationExternalId: conversation.id,
            observedAt: observedBase,
            dedupeKey: dedupeKey(`slack:conversation:${teamId}:${conversation.id}`),
            payload: {
                sourceConversationKey: `slack:${teamId}:${conversation.id}`,
                conversationType: conversation.is_mpim || conversation.is_channel || conversation.is_group ? "group" : "dm",
                displayName: buildConversationDisplayName(conversation, usersById),
                participants: memberIds.map((memberId) => ({
                    sourceEntityKey: slackSourceKey(teamId, memberId),
                })),
            },
            sourceVersion: "slack-v1",
        });
        const messages = await listConversationMessages(client, conversation.id, oldestMs);
        for (const message of messages) {
            const messageTsMs = timestampMs(message.ts) ?? observedBase;
            const attachments = toAttachmentMetadata(message);
            rawEvents.push({
                id: randomUUID(),
                platform: "slack",
                accountKey,
                entityKind: "message",
                eventKind: "message_created",
                externalEntityId: `${conversation.id}:${message.ts}`,
                conversationExternalId: conversation.id,
                occurredAt: messageTsMs,
                observedAt: observedBase,
                dedupeKey: dedupeKey(`slack:message:${teamId}:${conversation.id}:${message.ts}`),
                payload: {
                    sourceMessageKey: `slack:${teamId}:${conversation.id}:${message.ts}`,
                    sourceConversationKey: `slack:${teamId}:${conversation.id}`,
                    senderSourceKey: message.user ? slackSourceKey(teamId, message.user) : null,
                    sentAt: messageTsMs,
                    contentOriginal: message.text || attachments.map((attachment) => String(attachment.title ?? attachment.name ?? attachment.text ?? "")).filter(Boolean).join("\n"),
                    contentCurrent: message.text || attachments.map((attachment) => String(attachment.title ?? attachment.name ?? attachment.text ?? "")).filter(Boolean).join("\n"),
                    editedAt: timestampMs(message.edited?.ts),
                    isEdited: Boolean(message.edited?.ts),
                    isDeleted: false,
                    hasAttachments: attachments.length > 0,
                    attachments,
                },
                sourceVersion: "slack-v1",
            });
            for (const reaction of message.reactions ?? []) {
                for (const reactorUserId of reaction.users) {
                    rawEvents.push({
                        id: randomUUID(),
                        platform: "slack",
                        accountKey,
                        entityKind: "reaction",
                        eventKind: "reaction_added",
                        externalEntityId: `${conversation.id}:${message.ts}:${reaction.name}:${reactorUserId}`,
                        conversationExternalId: conversation.id,
                        occurredAt: messageTsMs,
                        observedAt: observedBase,
                        dedupeKey: dedupeKey(`slack:reaction:${teamId}:${conversation.id}:${message.ts}:${reaction.name}:${reactorUserId}`),
                        payload: {
                            sourceMessageKey: `slack:${teamId}:${conversation.id}:${message.ts}`,
                            sourceConversationKey: `slack:${teamId}:${conversation.id}`,
                            reactorSourceKey: reactorUserId === selfUserId ? null : slackSourceKey(teamId, reactorUserId),
                            emoji: `:${reaction.name}:`,
                            timestamp: messageTsMs,
                            isActive: true,
                        },
                        sourceVersion: "slack-v1",
                    });
                }
            }
        }
    }
    return {
        sourceAccounts,
        rawEvents,
        sourceCursor: {
            lastSyncAt: observedBase,
            teamId,
            selfUserId,
        },
        syncMode: options?.lastSyncAt && options.lastSyncAt > 0 ? "incremental" : "full",
    };
}
//# sourceMappingURL=slack-worker-lib.js.map