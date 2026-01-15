import { createSync } from 'nango';
import * as z from 'zod';
import type {
    SlackMessage,
    SlackConversation,
    SlackUser,
    ConversationsListResponse,
    ConversationsHistoryResponse,
    UsersInfoResponse
} from '../types.js';

// 30 days ago (default backfill period for Slack)
const DEFAULT_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

// Zod schemas
const OptionalBackfillSetting = z.object({
    backfillPeriodMs: z.number().optional()
});

const SlackReactionSchema = z.object({
    name: z.string(),
    count: z.number(),
    users: z.array(z.string())
});

const SlackSyncMessage = z.object({
    id: z.string(), // ts (timestamp is unique ID)
    channelId: z.string(),
    channelType: z.enum(['im', 'channel', 'group', 'mpim']),
    channelName: z.string().optional(), // Channel name or DM partner name
    userId: z.string().optional(), // Sender user ID
    userName: z.string().optional(), // Sender display name
    text: z.string(),
    ts: z.string(), // Original timestamp
    threadTs: z.string().optional(), // Parent thread if reply
    isThreadParent: z.boolean(), // Has replies
    reactions: SlackReactionSchema.array().optional(),
    isBot: z.boolean(),
    sentAt: z.string() // ISO date string
});
type SlackSyncMessage = z.infer<typeof SlackSyncMessage>;

const sync = createSync({
    description:
        'Fetches DM messages from Slack. Default backfill period is 30 days, configurable via metadata.backfillPeriodMs.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    syncType: 'incremental',

    endpoints: [
        {
            method: 'GET',
            path: '/messages',
            group: 'Messages'
        }
    ],

    scopes: [
        'im:read',
        'im:history',
        'channels:read',
        'channels:history',
        'users:read'
    ],

    models: { SlackSyncMessage },

    metadata: OptionalBackfillSetting,

    exec: async (nango) => {
        const metadata = await nango.getMetadata();
        const backfillMilliseconds = metadata?.backfillPeriodMs || DEFAULT_BACKFILL_MS;
        const backfillPeriod = new Date(Date.now() - backfillMilliseconds);
        const { lastSyncDate } = nango;
        const syncDate = lastSyncDate || backfillPeriod;

        // Convert to Slack timestamp format (seconds with microseconds)
        const oldestTs = Math.floor(syncDate.getTime() / 1000).toString();

        // User cache to store fetched user info
        const userCache = new Map<string, SlackUser>();

        // Step 1: Get all DM conversations
        const dmConversations = await fetchConversations(nango, 'im');
        await nango.log(`Found ${dmConversations.length} DM conversations`);

        // Step 2: Prefetch user info for DM partners
        for (const conversation of dmConversations) {
            if (conversation.user && !userCache.has(conversation.user)) {
                const user = await fetchUserInfo(nango, conversation.user);
                if (user) {
                    userCache.set(conversation.user, user);
                }
            }
        }

        // Step 3: Fetch messages from each DM
        for (const conversation of dmConversations) {
            const messages = await fetchConversationHistory(nango, conversation.id, oldestTs);

            if (messages.length === 0) {
                continue;
            }

            // Fetch user info for message senders not in cache
            for (const msg of messages) {
                if (msg.user && !userCache.has(msg.user)) {
                    const user = await fetchUserInfo(nango, msg.user);
                    if (user) {
                        userCache.set(msg.user, user);
                    }
                }
            }

            const syncMessages: SlackSyncMessage[] = messages.map((msg) =>
                mapMessage(msg, conversation, userCache)
            );

            await nango.batchSave(syncMessages, 'SlackSyncMessage');
            await nango.log(`Saved ${syncMessages.length} messages from DM ${conversation.id}`);
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

/**
 * Fetch all conversations of a given type
 */
async function fetchConversations(
    nango: NangoSyncLocal,
    types: 'im' | 'public_channel' | 'private_channel' | 'mpim'
): Promise<SlackConversation[]> {
    const conversations: SlackConversation[] = [];
    let cursor: string | undefined;

    do {
        const response = await nango.proxy<ConversationsListResponse>({
            method: 'get',
            endpoint: '/conversations.list',
            params: {
                types,
                limit: '200',
                exclude_archived: 'true',
                ...(cursor && { cursor })
            },
            retries: 5
        });

        if (!response.data.ok) {
            throw new Error('Failed to fetch conversations');
        }

        conversations.push(...response.data.channels);
        cursor = response.data.response_metadata?.next_cursor;
    } while (cursor);

    return conversations;
}

/**
 * Fetch message history for a conversation
 */
async function fetchConversationHistory(
    nango: NangoSyncLocal,
    channelId: string,
    oldest: string
): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
        const response = await nango.proxy<ConversationsHistoryResponse>({
            method: 'get',
            endpoint: '/conversations.history',
            params: {
                channel: channelId,
                oldest,
                limit: '200',
                ...(cursor && { cursor })
            },
            retries: 5
        });

        if (!response.data.ok) {
            await nango.log(`Warning: Could not fetch history for ${channelId}`);
            break;
        }

        // Filter out bot messages and subtypes
        const userMessages = response.data.messages.filter(
            (msg) => msg.type === 'message' && !msg.subtype
        );
        messages.push(...userMessages);

        cursor = response.data.has_more ? response.data.response_metadata?.next_cursor : undefined;
    } while (cursor);

    return messages;
}

/**
 * Fetch user info from Slack API
 */
async function fetchUserInfo(
    nango: NangoSyncLocal,
    userId: string
): Promise<SlackUser | null> {
    try {
        const response = await nango.proxy<UsersInfoResponse>({
            method: 'get',
            endpoint: '/users.info',
            params: { user: userId },
            retries: 3
        });

        if (!response.data.ok) {
            return null;
        }

        return response.data.user;
    } catch {
        return null;
    }
}

/**
 * Get display name for a Slack user
 */
function getUserDisplayName(user: SlackUser | undefined): string | undefined {
    if (!user) return undefined;
    return (
        user.profile.display_name ||
        user.profile.real_name ||
        user.real_name ||
        user.name
    );
}

/**
 * Get channel/conversation display name
 */
function getChannelDisplayName(
    conversation: SlackConversation,
    userCache: Map<string, SlackUser>
): string | undefined {
    // For channels, use the channel name
    if (conversation.name) {
        return conversation.name;
    }

    // For DMs, use the other user's display name
    if (conversation.is_im && conversation.user) {
        const user = userCache.get(conversation.user);
        return getUserDisplayName(user);
    }

    return undefined;
}

/**
 * Map a Slack message to our sync format
 */
function mapMessage(
    msg: SlackMessage,
    conversation: SlackConversation,
    userCache: Map<string, SlackUser>
): SlackSyncMessage {
    const channelType = getChannelType(conversation);
    const isBot = Boolean(msg.bot_id || msg.app_id);
    const senderUser = msg.user ? userCache.get(msg.user) : undefined;

    return {
        id: msg.ts,
        channelId: conversation.id,
        channelType,
        channelName: getChannelDisplayName(conversation, userCache),
        userId: msg.user,
        userName: getUserDisplayName(senderUser),
        text: msg.text,
        ts: msg.ts,
        threadTs: msg.thread_ts,
        isThreadParent: (msg.reply_count ?? 0) > 0,
        reactions: msg.reactions?.map((r) => ({
            name: r.name,
            count: r.count,
            users: r.users
        })),
        isBot,
        sentAt: tsToISODate(msg.ts)
    };
}

/**
 * Determine channel type from conversation object
 */
function getChannelType(conv: SlackConversation): 'im' | 'channel' | 'group' | 'mpim' {
    if (conv.is_im) return 'im';
    if (conv.is_mpim) return 'mpim';
    if (conv.is_private || conv.is_group) return 'group';
    return 'channel';
}

/**
 * Convert Slack timestamp to ISO date string
 */
function tsToISODate(ts: string): string {
    const seconds = parseFloat(ts);
    return new Date(seconds * 1000).toISOString();
}
