/**
 * Syncs contacts from macOS Contacts.app to Convex.
 *
 * Uses the ContactsManager to fetch contacts and the Convex API to sync them.
 *
 * IMPORTANT: This sync MUST be coordinated via SyncCoordinator to prevent
 * race conditions with iMessage sync that also writes to contactHandles.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@cued/convex";
import { isAuthError } from "../../auth/auth-utils";
import { electronEnv } from "@cued/env/electron";
import { getContactsManager } from "./manager";

const CONVEX_URL = electronEnv.CONVEX_URL;

const BATCH_SIZE = 50;

// Logging helper with timestamp and structured data
function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  data?: Record<string, unknown>
): void {
  const prefix = `[ContactsSync]`;
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  const fullMessage = `${prefix} ${message}${dataStr}`;

  switch (level) {
    case "error":
      console.error(fullMessage);
      break;
    case "warn":
      console.warn(fullMessage);
      break;
    case "debug":
      if (process.env.DEBUG_SYNC) console.log(fullMessage);
      break;
    default:
      console.log(fullMessage);
  }
}

function toSyncableAvatarUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

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
  getAuthToken: (forceRefresh?: boolean) => Promise<string | null>,
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
    log("info", "Fetching contacts from macOS", { forceRefresh });
    const fetchStart = performance.now();
    const contactsManager = getContactsManager();
    const contacts = await contactsManager.fetchContacts(forceRefresh);
    const fetchElapsed = Math.round(performance.now() - fetchStart);

    if (contacts.length === 0) {
      log("info", "No contacts to sync", { fetchElapsed });
      result.elapsed = performance.now() - startTime;
      return result;
    }

    log("info", "Fetched contacts from macOS", {
      count: contacts.length,
      fetchElapsed,
    });

    // Convert to Convex format and sync in batches
    const convexContacts = contacts.map((c) => ({
      displayName: c.displayName,
      company: c.company,
      phoneNumbers: c.phoneNumbers,
      emails: c.emails,
      avatarUrl: toSyncableAvatarUrl(c.avatarUrl),
    }));

    const totalBatches = Math.ceil(convexContacts.length / BATCH_SIZE);
    log("info", "Starting batch sync to Convex", {
      totalContacts: convexContacts.length,
      batchSize: BATCH_SIZE,
      totalBatches,
    });

    // Sync in batches with auth retry
    for (let i = 0; i < convexContacts.length; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batch = convexContacts.slice(i, i + BATCH_SIZE);
      const batchStart = performance.now();

      try {
        log("debug", `Processing batch ${batchNum}/${totalBatches}`, {
          batchSize: batch.length,
        });

        const batchResult = await client.mutation(api.sync.syncContacts, {
          contacts: batch,
        });

        const batchElapsed = Math.round(performance.now() - batchStart);
        log("debug", `Batch ${batchNum} complete`, {
          new: batchResult.contactsCount,
          updated: batchResult.updatedCount,
          handles: batchResult.handlesCount,
          errors: batchResult.errors.length,
          elapsed: batchElapsed,
        });

        result.contactsCount += batchResult.contactsCount;
        result.updatedCount += batchResult.updatedCount;
        result.handlesCount += batchResult.handlesCount;
        result.errors.push(...batchResult.errors);
      } catch (error) {
        // If auth error, try refreshing token and retry once
        if (isAuthError(error)) {
          log("warn", "Auth error, refreshing token and retrying", { batch: batchNum });
          const newToken = await getAuthToken(true);
          if (!newToken) {
            throw new Error("Token refresh failed, cannot retry request");
          }
          client.setAuth(newToken);

          const batchResult = await client.mutation(api.sync.syncContacts, {
            contacts: batch,
          });

          result.contactsCount += batchResult.contactsCount;
          result.updatedCount += batchResult.updatedCount;
          result.handlesCount += batchResult.handlesCount;
          result.errors.push(...batchResult.errors);
        } else {
          throw error;
        }
      }
    }

    const totalElapsed = Math.round(performance.now() - startTime);
    log("info", "Sync complete", {
      newContacts: result.contactsCount,
      updatedContacts: result.updatedCount,
      handles: result.handlesCount,
      errors: result.errors.length,
      elapsed: totalElapsed,
    });

    // Update server contacts sync state for recovery
    try {
      await client.mutation(api.sync.updateContactsSyncState, {
        platform: "imessage",
        contactsCount: contacts.length,
      });
      log("debug", "Updated server sync state");
    } catch (e) {
      log("warn", "Failed to update contacts sync state", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "Sync failed", { error: message });
    result.errors.push(message);
  }

  result.elapsed = performance.now() - startTime;
  return result;
}
