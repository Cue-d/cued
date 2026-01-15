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
// Google People API types
// https://developers.google.com/people/api/rest/v1/people

/**
 * A person's name
 */
export interface PersonName {
    displayName?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
    metadata?: FieldMetadata;
}

/**
 * A person's email address
 */
export interface PersonEmailAddress {
    value?: string;
    type?: string;
    formattedType?: string;
    displayName?: string;
    metadata?: FieldMetadata;
}

/**
 * A person's phone number
 */
export interface PersonPhoneNumber {
    value?: string;
    canonicalForm?: string;
    type?: string;
    formattedType?: string;
    metadata?: FieldMetadata;
}

/**
 * A person's organization (work info)
 */
export interface PersonOrganization {
    name?: string;
    title?: string;
    department?: string;
    type?: string;
    formattedType?: string;
    metadata?: FieldMetadata;
}

/**
 * Metadata about a field
 */
export interface FieldMetadata {
    primary?: boolean;
    verified?: boolean;
    source?: {
        type?: string;
        id?: string;
    };
}

/**
 * Metadata about a person resource
 */
export interface PersonMetadata {
    deleted?: boolean;
    objectType?: string;
    sources?: Array<{
        type?: string;
        id?: string;
        etag?: string;
        updateTime?: string;
    }>;
}

/**
 * A Google Contact (Person resource)
 */
export interface Person {
    resourceName: string;
    etag?: string;
    metadata?: PersonMetadata;
    names?: PersonName[];
    emailAddresses?: PersonEmailAddress[];
    phoneNumbers?: PersonPhoneNumber[];
    organizations?: PersonOrganization[];
    photos?: Array<{
        url?: string;
        metadata?: FieldMetadata;
    }>;
}

/**
 * Response from people.connections.list API
 */
export interface ListConnectionsResponse {
    connections?: Person[];
    nextPageToken?: string;
    nextSyncToken?: string;
    totalItems?: number;
}
