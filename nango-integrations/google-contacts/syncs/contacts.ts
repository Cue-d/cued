import { createSync } from 'nango';
import * as z from 'zod';
import type { Person, ListConnectionsResponse } from '../types.js';

const SyncMetadata = z.object({
    syncToken: z.string().optional()
});

const GoogleContact = z.object({
    id: z.string(),
    name: z.string(),
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    company: z.string().optional(),
    title: z.string().optional(),
    isDeleted: z.boolean()
});
type GoogleContact = z.infer<typeof GoogleContact>;

const sync = createSync({
    description:
        'Fetches contacts from Google People API. Uses syncToken for incremental sync (expires after 7 days).',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    syncType: 'incremental',

    endpoints: [
        {
            method: 'GET',
            path: '/contacts',
            group: 'Contacts'
        }
    ],

    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],

    models: {
        GoogleContact: GoogleContact
    },

    metadata: SyncMetadata,

    exec: async (nango) => {
        const PAGE_SIZE = 100;
        const BASE_PARAMS = {
            pageSize: `${PAGE_SIZE}`,
            personFields: 'names,emailAddresses,phoneNumbers,organizations,metadata',
            requestSyncToken: 'true',
            sortOrder: 'LAST_MODIFIED_DESCENDING'
        };

        const metadata = await nango.getMetadata();
        let syncToken = metadata?.syncToken;
        let nextPageToken: string | undefined;
        let newSyncToken: string | undefined;

        do {
            const params: Record<string, string> = { ...BASE_PARAMS };

            if (nextPageToken) {
                params['pageToken'] = nextPageToken;
            } else if (syncToken) {
                params['syncToken'] = syncToken;
            }

            let response: { data: ListConnectionsResponse };
            try {
                response = await nango.proxy({
                    method: 'get',
                    endpoint: '/v1/people/me/connections',
                    baseUrlOverride: 'https://people.googleapis.com',
                    params,
                    retries: 10
                });
            } catch (error: unknown) {
                const err = error as { response?: { status?: number } };
                if (err?.response?.status === 410 && syncToken) {
                    await nango.log('Sync token expired, performing full sync');
                    syncToken = undefined;
                    await nango.updateMetadata({ syncToken: undefined });
                    response = await nango.proxy({
                        method: 'get',
                        endpoint: '/v1/people/me/connections',
                        baseUrlOverride: 'https://people.googleapis.com',
                        params: BASE_PARAMS,
                        retries: 10
                    });
                } else {
                    throw error;
                }
            }

            const contacts = (response.data.connections || []).map(mapContact);

            if (contacts.length > 0) {
                await nango.batchSave(contacts, 'GoogleContact');
                await nango.log(`Saved ${contacts.length} contacts`);
            }

            if (response.data.nextSyncToken) {
                newSyncToken = response.data.nextSyncToken;
            }

            nextPageToken = response.data.nextPageToken;
        } while (nextPageToken);

        if (newSyncToken) {
            await nango.updateMetadata({ syncToken: newSyncToken });
        }
    }
});

export default sync;

function findPrimary<T extends { metadata?: { primary?: boolean } }>(items: T[] | undefined): T | undefined {
    return items?.find((item) => item.metadata?.primary) ?? items?.[0];
}

function mapContact(person: Person): GoogleContact {
    const primaryName = findPrimary(person.names);
    const primaryOrg = findPrimary(person.organizations);

    const displayName =
        primaryName?.displayName ||
        [primaryName?.givenName, primaryName?.familyName].filter(Boolean).join(' ') ||
        '';

    const emails = (person.emailAddresses || [])
        .map((e) => e.value)
        .filter((v): v is string => Boolean(v));

    const phones = (person.phoneNumbers || [])
        .map((p) => p.canonicalForm || p.value)
        .filter((v): v is string => Boolean(v));

    return {
        id: person.resourceName,
        name: displayName,
        emails,
        phones,
        company: primaryOrg?.name,
        title: primaryOrg?.title,
        isDeleted: person.metadata?.deleted ?? false
    };
}
