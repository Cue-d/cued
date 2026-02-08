/**
 * Trigger retroactive action analysis for Twitter conversations.
 * Finds conversations with recent messages but no pending actions,
 * and schedules LLM analysis for them.
 *
 * Usage: CONVEX_URL=... CONVEX_AUTH_TOKEN=... pnpm twitter:trigger-actions
 *        CONVEX_URL=... CONVEX_AUTH_TOKEN=... pnpm twitter:trigger-actions 14  # 14 days back
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@cued/convex'

async function main() {
  const convexUrl = process.env.CONVEX_URL
  const authToken = process.env.CONVEX_AUTH_TOKEN

  if (!convexUrl) {
    console.error('[trigger-actions] Missing CONVEX_URL env var')
    process.exit(1)
  }
  if (!authToken) {
    console.error('[trigger-actions] Missing CONVEX_AUTH_TOKEN env var')
    process.exit(1)
  }

  const daysBack = process.argv[2] ? parseInt(process.argv[2], 10) : 7

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(authToken)

  console.log(`[trigger-actions] Triggering action analysis for Twitter conversations (${daysBack} days back)`)

  // First, show current state
  const status = await client.query(api.debug.getPlatformSyncStatus, { platform: 'twitter' })
  if (status) {
    console.log(`[trigger-actions] Current state:`)
    console.log(`  Conversations: ${status.stats.totalConversations}`)
    console.log(`  Recent messages: ${status.stats.totalRecentMessages}`)
    console.log(`  Pending actions: ${status.stats.pendingActions}`)
  }

  // Trigger analysis
  const result = await client.mutation(api.debug.triggerActionAnalysis, {
    platform: 'twitter',
    daysBack,
  })

  console.log(`[trigger-actions] Result:`)
  console.log(`  Total conversations: ${result.totalConversations}`)
  console.log(`  Eligible for analysis: ${result.eligibleForAnalysis}`)
  console.log(`  Skipped (already have pending action): ${result.skippedWithPendingAction}`)
  console.log(`  Cutoff date: ${result.cutoffDate}`)

  if (result.eligibleForAnalysis > 0) {
    console.log(`\n[trigger-actions] Scheduled analysis for ${result.eligibleForAnalysis} conversations.`)
    console.log(`[trigger-actions] Actions will be created asynchronously by the Convex backend.`)
  } else {
    console.log(`\n[trigger-actions] No conversations eligible for analysis.`)
    if (result.totalConversations === 0) {
      console.log(`[trigger-actions] No Twitter conversations found. Run sync first.`)
    }
  }
}

main().catch((err) => {
  console.error('[trigger-actions] Fatal error:', err)
  process.exit(1)
})
