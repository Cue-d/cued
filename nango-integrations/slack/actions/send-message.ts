import { createAction } from 'nango';
import * as z from 'zod';

/**
 * Input schema for sending a Slack message
 */
const SlackMessageInput = z.object({
    channel: z.string(), // Channel ID (C...) or DM ID (D...)
    text: z.string(), // Message content
    thread_ts: z.string().optional() // Thread timestamp for replies
});

/**
 * Output schema for sent message
 */
const SlackMessageOutput = z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string(), // Message timestamp (unique ID)
    message: z
        .object({
            text: z.string(),
            user: z.string().optional(),
            ts: z.string()
        })
        .optional()
});

/**
 * Response from chat.postMessage API
 */
interface ChatPostMessageResponse {
    ok: boolean;
    channel: string;
    ts: string;
    message?: {
        text: string;
        user?: string;
        ts: string;
    };
    error?: string;
}

const action = createAction({
    description: 'Send a message to a Slack channel or DM',
    version: '1.0.0',

    endpoint: {
        method: 'POST',
        path: '/slack/messages',
        group: 'Messages'
    },

    scopes: ['chat:write', 'im:write'],

    input: SlackMessageInput,
    output: SlackMessageOutput,

    exec: async (nango, input) => {
        const response = await nango.proxy<ChatPostMessageResponse>({
            method: 'post',
            endpoint: '/chat.postMessage',
            data: {
                channel: input.channel,
                text: input.text,
                ...(input.thread_ts && { thread_ts: input.thread_ts })
            },
            retries: 3
        });

        if (!response.data.ok) {
            throw new Error(`Failed to send message: ${response.data.error}`);
        }

        return {
            ok: response.data.ok,
            channel: response.data.channel,
            ts: response.data.ts,
            message: response.data.message
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
