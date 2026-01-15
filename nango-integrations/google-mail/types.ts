// Gmail API types (based on Google API TypeScript client)
// https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/gmail/v1.ts

/**
 * An email message.
 */
export interface Schema$Message {
    /**
     * The ID of the last history record that modified this message.
     */
    historyId?: string | null;
    /**
     * The immutable ID of the message.
     */
    id: string;
    /**
     * The internal message creation timestamp (epoch ms).
     */
    internalDate: string;
    /**
     * List of IDs of labels applied to this message.
     */
    labelIds?: string[] | null;
    /**
     * The parsed email structure in the message parts.
     */
    payload?: Schema$MessagePart;
    /**
     * The entire email message in an RFC 2822 formatted and base64url encoded string.
     */
    raw?: string | null;
    /**
     * Estimated size in bytes of the message.
     */
    sizeEstimate?: number | null;
    /**
     * A short part of the message text.
     */
    snippet?: string | null;
    /**
     * The ID of the thread the message belongs to.
     */
    threadId: string;
}

/**
 * A single MIME message part.
 */
export interface Schema$MessagePart {
    /**
     * The message part body for this part.
     */
    body?: Schema$MessagePartBody;
    /**
     * The filename of the attachment. Only present if this message part represents an attachment.
     */
    filename?: string | null;
    /**
     * List of headers on this message part.
     */
    headers?: Schema$MessagePartHeader[];
    /**
     * The MIME type of the message part.
     */
    mimeType?: string | null;
    /**
     * The immutable ID of the message part.
     */
    partId?: string | null;
    /**
     * The child MIME message parts of this part.
     */
    parts?: Schema$MessagePart[];
}

/**
 * The body of a single MIME message part.
 */
export interface Schema$MessagePartBody {
    /**
     * When present, contains the ID of an external attachment.
     */
    attachmentId?: string | null;
    /**
     * The body data as a base64url encoded string.
     */
    data?: string | null;
    /**
     * Number of bytes for the message part data.
     */
    size?: number | null;
}

export interface Schema$MessagePartHeader {
    /**
     * The name of the header before the `:` separator.
     */
    name?: string | null;
    /**
     * The value of the header after the `:` separator.
     */
    value?: string | null;
}
