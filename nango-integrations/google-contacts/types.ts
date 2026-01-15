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
