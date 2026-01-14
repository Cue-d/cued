/**
 * Syncs contacts from macOS Contacts.app to Convex.
 *
 * Uses the ContactsManager to fetch contacts and the Convex API to sync them.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import { getContactsManager } from "./contacts";

const CONVEX_URL =
  process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

const BATCH_SIZE = 50;

export interface ContactsSyncResult {
  contactsCount: number;
  updatedCount: number;
  handlesCount: number;
  errors: string[];
  elapsed: number;
}

/**
 * Sync all contacts from macOS Contacts.app to Convex.
 *
 * @param getAuthToken - Function to get a valid auth token
 * @param forceRefresh - If true, bypass contact cache and fetch fresh data
 */
export async function syncContactsToConvex(
  getAuthToken: () => Promise<string | null>,
  forceRefresh = false
): Promise<ContactsSyncResult> {
  const startTime = performance.now();
  const result: ContactsSyncResult = {
    contactsCount: 0,
    updatedCount: 0,
    handlesCount: 0,
    errors: [],
    elapsed: 0,
  };

  try {
    // Get auth token
    const token = await getAuthToken();
    if (!token) {
      result.errors.push("No auth token available");
      result.elapsed = performance.now() - startTime;
      return result;
    }

    // Initialize Convex client with auth
    const client = new ConvexHttpClient(CONVEX_URL);
    client.setAuth(token);

    // Fetch contacts from macOS Contacts.app
    const contactsManager = getContactsManager();
    const contacts = await contactsManager.fetchContacts(forceRefresh);

    if (contacts.length === 0) {
      console.log("[ContactsSync] No contacts to sync");
      result.elapsed = performance.now() - startTime;
      return result;
    }

    // Convert to Convex format and sync in batches
    const convexContacts = contacts.map((c) => ({
      displayName: c.displayName,
      company: c.company,
      phoneNumbers: c.phoneNumbers,
      emails: c.emails,
    }));

    // Sync in batches
    for (let i = 0; i < convexContacts.length; i += BATCH_SIZE) {
      const batch = convexContacts.slice(i, i + BATCH_SIZE);
      const batchResult = await client.mutation(api.sync.syncContacts, {
        contacts: batch,
      });

      result.contactsCount += batchResult.contactsCount;
      result.updatedCount += batchResult.updatedCount;
      result.handlesCount += batchResult.handlesCount;
      result.errors.push(...batchResult.errors);
    }

    console.log(
      `[ContactsSync] Synced ${result.contactsCount} contacts (${result.updatedCount} updated, ${result.handlesCount} handles)`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ContactsSync] Error:", message);
    result.errors.push(message);
  }

  result.elapsed = performance.now() - startTime;
  return result;
}
