/**
 * Test script for syncContacts mutation.
 * Usage: npx tsx apps/electron/src/main/sync/test-sync-contacts.ts
 *
 * This fetches real contacts from macOS Contacts.app and syncs them to Convex.
 */

import { ConvexHttpClient } from "convex/browser";
import { getContactsManager } from "./contacts";
import { api } from "@prm/convex";

const CONVEX_URL = process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

async function main() {
  console.log("Fetching contacts from macOS Contacts.app...");

  const contactsManager = getContactsManager();
  const contacts = await contactsManager.fetchContacts();

  console.log(`Found ${contacts.length} contacts`);

  // Convert to format expected by syncContacts mutation
  const contactsInput = contacts.map((c) => ({
    displayName: c.displayName,
    company: c.company,
    phoneNumbers: c.phoneNumbers,
    emails: c.emails,
  }));

  const client = new ConvexHttpClient(CONVEX_URL);

  // Batch contacts to avoid timeout (50 per batch)
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < contactsInput.length; i += BATCH_SIZE) {
    batches.push(contactsInput.slice(i, i + BATCH_SIZE));
  }

  console.log(`Syncing ${contactsInput.length} contacts in ${batches.length} batches...`);

  let totalResult = {
    contactsCount: 0,
    updatedCount: 0,
    handlesCount: 0,
    errors: [] as string[],
  };

  for (let i = 0; i < batches.length; i++) {
    console.log(`  Batch ${i + 1}/${batches.length} (${batches[i].length} contacts)...`);
    const result = await client.mutation(api.sync.syncContactsTest, {
      contacts: batches[i],
    });
    totalResult.contactsCount += result.contactsCount;
    totalResult.updatedCount += result.updatedCount;
    totalResult.handlesCount += result.handlesCount;
    totalResult.errors.push(...result.errors);
  }

  const result = totalResult;

  console.log("Sync result:", result);
  console.log(`  New contacts: ${result.contactsCount}`);
  console.log(`  Updated contacts: ${result.updatedCount}`);
  console.log(`  New handles: ${result.handlesCount}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`    - ${error}`);
    }
    if (result.errors.length > 5) {
      console.log(`    ... and ${result.errors.length - 5} more`);
    }
  }
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  if (e.data) console.error("Data:", e.data);
  process.exit(1);
});
