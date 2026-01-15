import { createSync } from 'nango';
import * as z from 'zod';
import type {
    SlackMessage,
    SlackConversation,
    ConversationsListResponse,
    ConversationsHistoryResponse
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
    userId: z.string().optional(), // Sender user ID
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

    models: {
        SlackSyncMessage: SlackSyncMessage
    },

    metadata: OptionalBackfillSetting,

    exec: async (nango) => {
        const metadata = await nango.getMetadata();
        const backfillMilliseconds = metadata?.backfillPeriodMs || DEFAULT_BACKFILL_MS;
        const backfillPeriod = new Date(Date.now() - backfillMilliseconds);
        const { lastSyncDate } = nango;
        const syncDate = lastSyncDate || backfillPeriod;

        // Convert to Slack timestamp format (seconds with microseconds)
        const oldestTs = Math.floor(syncDate.getTime() / 1000).toString();

        // Step 1: Get all DM conversations
        const dmConversations = await fetchConversations(nango, 'im');
        await nango.log(`Found ${dmConversations.length} DM conversations`);

        // Step 2: Fetch messages from each DM
        for (const conversation of dmConversations) {
            const messages = await fetchConversationHistory(nango, conversation.id, oldestTs);

            if (messages.length === 0) {
                continue;
            }

            const syncMessages: SlackSyncMessage[] = messages.map((msg) =>
                mapMessage(msg, conversation)
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
    let cursor: string | undefined = '';

    do {
        const response: { data: ConversationsListResponse } = await nango.proxy({
            method: 'get',
            endpoint: '/conversations.list',
            params: {
                types,
                limit: '200',
                exclude_archived: 'true',
                ...(cursor ? { cursor } : {})
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
    let cursor: string | undefined = '';

    do {
        const response: { data: ConversationsHistoryResponse } = await nango.proxy({
            method: 'get',
            endpoint: '/conversations.history',
            params: {
                channel: channelId,
                oldest,
                limit: '200',
                ...(cursor ? { cursor } : {})
            },
            retries: 5
        });

        if (!response.data.ok) {
            // Channel might be inaccessible, skip instead of failing
            await nango.log(`Warning: Could not fetch history for ${channelId}`);
            break;
        }

        // Filter out bot messages and subtypes we don't want
        const userMessages = response.data.messages.filter(
            (msg) => msg.type === 'message' && !msg.subtype
        );
        messages.push(...userMessages);

        cursor = response.data.has_more ? response.data.response_metadata?.next_cursor : undefined;
    } while (cursor);

    return messages;
}

/**
 * Map a Slack message to our sync format
 */
function mapMessage(msg: SlackMessage, conversation: SlackConversation): SlackSyncMessage {
    const channelType = getChannelType(conversation);
    const isBot = Boolean(msg.bot_id || msg.app_id);

    return {
        id: msg.ts,
        channelId: conversation.id,
        channelType,
        userId: msg.user,
        text: msg.text,
        ts: msg.ts,
        threadTs: msg.thread_ts,
        isThreadParent: Boolean(msg.reply_count && msg.reply_count > 0),
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
