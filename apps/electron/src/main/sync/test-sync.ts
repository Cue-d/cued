/**
 * Test script to verify syncMessages mutation with real iMessage data.
 *
 * Run with: npx tsx apps/electron/src/main/sync/test-sync.ts
 */

import { ChatDb } from "./chat-db";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const CONVEX_URL = process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

async function main() {
  console.log("🔍 Opening chat.db...");

  const chatDb = new ChatDb();

  // Get max ROWID to understand the data range
  const maxRowid = chatDb.getMaxMessageRowid();
  console.log(`📊 Max message ROWID: ${maxRowid}`);

  // Fetch last 50 messages (from cursor 0 means from beginning, but we want recent)
  const recentCursor = Math.max(0, maxRowid - 100);
  console.log(`📥 Fetching messages since ROWID ${recentCursor}...`);

  const batch = chatDb.buildSyncBatch(recentCursor);

  console.log(`\n📦 Sync Batch Summary:`);
  console.log(`  - Cursor: ${batch.cursor}`);
  console.log(`  - Chats: ${batch.chats.length}`);
  console.log(`  - Messages: ${batch.messages.length}`);
  console.log(`  - Handles: ${batch.handles.length}`);

  // Print sample data
  if (batch.chats.length > 0) {
    console.log(`\n💬 Sample Chat:`);
    const chat = batch.chats[0];
    console.log(`  - ID: ${chat.id}`);
    console.log(`  - Identifier: ${chat.identifier}`);
    console.log(`  - Display Name: ${chat.displayName}`);
    console.log(`  - Is Group: ${chat.isGroup}`);
    console.log(`  - Participants: ${chat.participants.length}`);
  }

  if (batch.messages.length > 0) {
    console.log(`\n📝 Sample Messages (first 3):`);
    for (const msg of batch.messages.slice(0, 3)) {
      console.log(`  - [${msg.id}] ${msg.isFromMe ? "→" : "←"} ${msg.text?.substring(0, 50)}...`);
      console.log(`    Chat: ${msg.chatId}, Time: ${new Date(msg.timestamp * 1000).toISOString()}`);
    }
  }

  // Test mutation call (requires auth - will fail without token)
  console.log(`\n🚀 Testing Convex mutation...`);
  console.log(`  URL: ${CONVEX_URL}`);

  const client = new ConvexHttpClient(CONVEX_URL);

  // Use test mutation (no auth required for dev testing)
  try {
    const result = await client.mutation(api.sync.syncMessagesTest, { batch });
    console.log(`\n✅ Sync successful!`);
    console.log(`  - Chats synced: ${result.chatsCount}`);
    console.log(`  - Messages synced: ${result.messagesCount}`);
    console.log(`  - Errors: ${result.errors.length}`);
    if (result.errors.length > 0) {
      console.log(`  - Error details:`, result.errors.slice(0, 5));
    }
  } catch (error: any) {
    console.error(`\n❌ Error:`, error.message);
    if (error.data) {
      console.error(`   Data:`, error.data);
    }
  }

  chatDb.close();
  console.log(`\n✅ Test complete`);
}

main().catch(console.error);
