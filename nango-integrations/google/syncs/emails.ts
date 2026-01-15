import { createSync } from 'nango';
import * as z from 'zod';
import type { Schema$Message, Schema$MessagePart } from '../types.js';

// 1 year ago (default backfill period)
const DEFAULT_BACKFILL_MS = 365 * 24 * 60 * 60 * 1000;

// Zod schemas
const OptionalBackfillSetting = z.object({
    backfillPeriodMs: z.number().optional()
});

const Attachment = z.object({
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    attachmentId: z.string()
});
type Attachment = z.infer<typeof Attachment>;

const GmailEmail = z.object({
    id: z.string(),
    sender: z.string(),
    recipients: z.string().optional(),
    date: z.string(),
    subject: z.string(),
    body: z.string().optional(),
    attachments: Attachment.array(),
    threadId: z.string()
});
type GmailEmail = z.infer<typeof GmailEmail>;

const sync = createSync({
    description:
        'Fetches emails from Gmail. Default backfill period is 1 year, configurable via metadata.backfillPeriodMs.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    syncType: 'incremental',

    endpoints: [
        {
            method: 'GET',
            path: '/emails',
            group: 'Emails'
        }
    ],

    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

    models: {
        GmailEmail: GmailEmail
    },

    metadata: OptionalBackfillSetting,

    exec: async (nango) => {
        const metadata = await nango.getMetadata();
        const backfillMilliseconds = metadata?.backfillPeriodMs || DEFAULT_BACKFILL_MS;
        const backfillPeriod = new Date(Date.now() - backfillMilliseconds);
        const { lastSyncDate } = nango;
        const syncDate = lastSyncDate || backfillPeriod;

        const pageSize = 100;
        let nextPageToken: string | undefined = '';

        do {
            // https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list
            const response: any = await nango.proxy({
                method: 'get',
                endpoint: '/gmail/v1/users/me/messages',
                params: {
                    maxResults: `${pageSize}`,
                    q: `after:${Math.floor(syncDate.getTime() / 1000)}`,
                    pageToken: nextPageToken
                },
                retries: 10
            });

            const messageList = response.data.messages || [];
            const emails: GmailEmail[] = [];

            for (const message of messageList) {
                const messageDetail = await nango.proxy<Schema$Message>({
                    method: 'get',
                    endpoint: `/gmail/v1/users/me/messages/${message.id}`,
                    retries: 10
                });

                const headers: Record<string, string> =
                    messageDetail.data.payload?.headers?.reduce((acc: Record<string, string>, current) => {
                        if (current.name && current.value) {
                            return {
                                ...acc,
                                [current.name]: current.value
                            };
                        }
                        return acc;
                    }, {}) || {};

                emails.push(mapEmail(messageDetail.data, headers));
            }

            await nango.batchSave(emails, 'GmailEmail');
            await nango.log(`Saved ${emails.length} emails`);

            nextPageToken = response.data.nextPageToken;
        } while (nextPageToken);
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

function processParts(parts: Schema$MessagePart[], bodyObj: { body: string }, attachments: Attachment[]): void {
    for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data && !bodyObj.body) {
            bodyObj.body = Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (part.mimeType === 'text/html' && part.body?.data && !bodyObj.body) {
            bodyObj.body = Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (part.filename && part.body?.attachmentId) {
            if (part.mimeType && part.body?.size !== undefined && part.body?.size !== null) {
                attachments.push({
                    filename: part.filename,
                    mimeType: part.mimeType,
                    size: part.body.size,
                    attachmentId: part.body.attachmentId
                });
            }
        }
        if (part.parts?.length) {
            processParts(part.parts, bodyObj, attachments);
        }
    }
}

function mapEmail(messageDetail: Schema$Message, headers: Record<string, string>): GmailEmail {
    const parts = messageDetail.payload?.parts || [];
    const bodyObj = { body: '' };
    const attachments: Attachment[] = [];

    if (parts.length > 0) {
        processParts(parts, bodyObj, attachments);
    } else if (messageDetail.payload?.body?.data) {
        // Handle simple API-sent emails with direct body data
        bodyObj.body = Buffer.from(messageDetail.payload.body.data, 'base64').toString('utf8');
    } else if (messageDetail.snippet) {
        bodyObj.body = messageDetail.snippet;
    }

    return {
        id: messageDetail.id,
        sender: headers['From'] || '',
        recipients: headers['To'],
        date: new Date(parseInt(messageDetail.internalDate)).toISOString(),
        subject: headers['Subject'] || '',
        body: bodyObj.body,
        attachments,
        threadId: messageDetail.threadId
    };
}
