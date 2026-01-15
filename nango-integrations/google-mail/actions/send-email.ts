import { createAction } from 'nango';
import * as z from 'zod';

const GmailEmailInput = z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    threadId: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional()
});

const GmailEmailOutput = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional()
});

/** Encode string to base64url (RFC 4648) without padding */
function encodeBase64Url(str: string): string {
    return Buffer.from(str, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/** Build RFC 2822 formatted email message */
function buildRawEmail(
    to: string,
    subject: string,
    body: string,
    inReplyTo?: string,
    references?: string
): string {
    const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=UTF-8'
    ];

    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);

    return [...headers, '', body].join('\r\n');
}

const action = createAction({
    description: 'Send an email via Gmail',
    version: '1.0.0',

    endpoint: {
        method: 'POST',
        path: '/google-mail/emails',
        group: 'Emails'
    },

    scopes: ['https://www.googleapis.com/auth/gmail.send'],

    input: GmailEmailInput,
    output: GmailEmailOutput,

    exec: async (nango, input) => {
        const rawEmail = buildRawEmail(
            input.to,
            input.subject,
            input.body,
            input.inReplyTo,
            input.references
        );

        const response = await nango.proxy<z.infer<typeof GmailEmailOutput>>({
            method: 'post',
            endpoint: '/gmail/v1/users/me/messages/send',
            data: {
                raw: encodeBase64Url(rawEmail),
                ...(input.threadId && { threadId: input.threadId })
            },
            retries: 3
        });

        return response.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
