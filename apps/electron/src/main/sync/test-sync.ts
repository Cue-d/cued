/**
 * Test script to verify syncMessages mutation with real iMessage data.
 *
 * Run with: npx tsx apps/electron/src/main/sync/test-sync.ts [messageCount]
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import { ChatDb } from "./chat-db";

const CONVEX_URL = process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

async function main(): Promise<void> {
  const messageCount = parseInt(process.argv[2] || "1000", 10);

  console.log("🔍 Opening chat.db...");
  const chatDb = new ChatDb();

  // Get max ROWID to understand the data range
  const maxRowid = chatDb.getMaxMessageRowid();
  console.log(`📊 Max message ROWID: ${maxRowid}`);
  console.log(`📊 Requesting last ${messageCount} messages\n`);

  // Fetch messages
  const recentCursor = Math.max(0, maxRowid - messageCount);

  const fetchStart = performance.now();
  const batch = chatDb.buildSyncBatch(recentCursor);
  const fetchTime = performance.now() - fetchStart;

  console.log(`📦 Batch Built:`);
  console.log(`  - Chats: ${batch.chats.length}`);
  console.log(`  - Messages: ${batch.messages.length}`);
  console.log(`  - Handles: ${batch.handles.length}`);
  console.log(`  - Fetch time: ${fetchTime.toFixed(1)}ms`);
  console.log(`  - Fetch rate: ${(batch.messages.length / (fetchTime / 1000)).toFixed(0)} msgs/sec`);

  // Sync to Convex
  console.log(`\n🚀 Syncing to Convex...`);
  const client = new ConvexHttpClient(CONVEX_URL);

  const syncStart = performance.now();
  try {
    const result = await client.mutation(api.sync.syncMessagesTest, { batch });
    const syncTime = performance.now() - syncStart;

    console.log(`\n✅ Sync Complete!`);
    console.log(`  - Chats synced: ${result.chatsCount}`);
    console.log(`  - Messages synced: ${result.messagesCount}`);
    console.log(`  - Errors: ${result.errors.length}`);
    console.log(`  - Sync time: ${syncTime.toFixed(1)}ms`);
    console.log(`  - Sync rate: ${(result.messagesCount / (syncTime / 1000)).toFixed(0)} msgs/sec`);

    const totalTime = fetchTime + syncTime;
    console.log(`\n📈 Total:`);
    console.log(`  - Total time: ${totalTime.toFixed(1)}ms`);
    console.log(`  - End-to-end rate: ${(result.messagesCount / (totalTime / 1000)).toFixed(0)} msgs/sec`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️ Errors (first 5):`, result.errors.slice(0, 5));
    }
  } catch (error: any) {
    const syncTime = performance.now() - syncStart;
    console.error(`\n❌ Error after ${syncTime.toFixed(1)}ms:`, error.message);
    if (error.data) {
      console.error(`   Data:`, JSON.stringify(error.data).slice(0, 500));
    }
  }

  chatDb.close();
}

main().catch(console.error);
