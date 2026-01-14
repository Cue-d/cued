#!/usr/bin/env npx tsx

/**
 * Reset and Reseed Script
 *
 * Performs a full database reset for development testing:
 * 1. Drops all Convex data (messages, conversations, contacts, contactHandles, actions)
 * 2. Resets sync cursors and metadata in integrations table
 * 3. Clears local Electron cache (contacts cache, sync state)
 * 4. Triggers automatic full re-sync on next Electron launch
 *
 * Usage: PRM_ACCESS_TOKEN=<token> pnpm reset-and-reseed
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

const HOME = os.homedir();

// Cache files to clear: [directory, filename]
const CACHE_FILES: Array<[string, string]> = [
  [path.join(HOME, "Library", "Application Support", "prm-electron"), "sync_cursor.json"],
  [path.join(HOME, ".prm"), "contacts_cache.json"],
];

function promptConfirmation(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\nWARNING: This will DELETE ALL your data!\n");
    console.log("This script will:");
    console.log("  - Delete all messages from Convex");
    console.log("  - Delete all conversations from Convex");
    console.log("  - Delete all contacts and handles from Convex");
    console.log("  - Delete all actions from Convex");
    console.log("  - Reset sync cursors in Convex");
    console.log("  - Clear local Electron cache files\n");

    rl.question('Type "reset" to confirm: ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "reset");
    });
  });
}

function clearLocalCache(): { cleared: string[]; missing: string[] } {
  const cleared: string[] = [];
  const missing: string[] = [];

  for (const [dir, filename] of CACHE_FILES) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      cleared.push(filePath);
    } else {
      missing.push(filePath);
    }
  }

  return { cleared, missing };
}

interface ResetResult {
  success: boolean;
  stats?: Record<string, number>;
  error?: string;
}

async function resetConvexData(accessToken: string): Promise<ResetResult> {
  const convexUrl = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return {
      success: false,
      error: "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL not set. Run from apps/web directory.",
    };
  }

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(accessToken);

  try {
    const result = await client.mutation(api.reset.resetAllUserData, {
      confirmReset: "I_UNDERSTAND_THIS_DELETES_ALL_MY_DATA",
    });
    return { success: result.success, stats: result.stats };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  console.log("PRM Reset and Reseed Script\n");

  const accessToken = process.env.PRM_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("Error: PRM_ACCESS_TOKEN environment variable not set.\n");
    console.log("To get your access token:");
    console.log("1. Open Electron app and sign in");
    console.log("2. Open DevTools (Cmd+Option+I)");
    console.log("3. Run: await window.electronAPI.auth.getState()");
    console.log("4. Copy the accessToken value");
    console.log("5. Run: PRM_ACCESS_TOKEN=<token> pnpm reset-and-reseed\n");
    process.exit(1);
  }

  const confirmed = await promptConfirmation();
  if (!confirmed) {
    console.log("\nReset cancelled.\n");
    process.exit(0);
  }

  console.log("\nStarting reset...\n");

  // Clear local cache
  console.log("Clearing local cache files...");
  const cacheResult = clearLocalCache();
  for (const file of cacheResult.cleared) {
    console.log(`  Deleted: ${file}`);
  }
  for (const file of cacheResult.missing) {
    console.log(`  Not found (ok): ${file}`);
  }

  // Reset Convex data
  console.log("\nResetting Convex data...");
  const convexResult = await resetConvexData(accessToken);

  if (!convexResult.success) {
    console.error(`  Error: ${convexResult.error}`);
    process.exit(1);
  }

  if (convexResult.stats) {
    const { stats } = convexResult;
    console.log(`  Messages deleted: ${stats.messagesDeleted}`);
    console.log(`  Conversations deleted: ${stats.conversationsDeleted}`);
    console.log(`  Contacts deleted: ${stats.contactsDeleted}`);
    console.log(`  Contact handles deleted: ${stats.contactHandlesDeleted}`);
    console.log(`  Actions deleted: ${stats.actionsDeleted}`);
    console.log(`  Integrations reset: ${stats.integrationsReset}`);
  }

  console.log("\nReset complete!\n");
  console.log("Next steps:");
  console.log("1. Launch the Electron app");
  console.log("2. Full sync will start automatically");
  console.log("3. Wait for sync to complete (check progress in UI)\n");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
