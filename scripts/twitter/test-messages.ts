/**
 * Test Twitter DM functionality: bootstrap session, read conversations, send a message.
 *
 * Usage:
 *   pnpm twitter:test-messages                    # read inbox
 *   pnpm twitter:test-messages send <user> <msg>  # send DM
 *   pnpm twitter:test-messages history <user>     # read history with user
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COOKIES_PATH = resolve(__dirname, '.cookies.json')

// Use tsx's tsconfig path resolution by going through the barrel export
// tsx with --tsconfig can resolve bundler-style imports
const { TwitterClient, defaultDMRequestQuery, parseTwitterEvent } = await import(
  '../../apps/electron/src/main/platforms/twitter/api/index.ts'
)
type Cookie = import('../../apps/electron/src/main/platforms/twitter/api/types').Cookie

/** Build 1-on-1 DM conversation ID from two user IDs (smaller ID first). */
function buildConversationId(userIdA: string, userIdB: string): string {
  return BigInt(userIdA) < BigInt(userIdB)
    ? `${userIdA}-${userIdB}`
    : `${userIdB}-${userIdA}`
}

function loadCookies(): Cookie[] {
  try {
    const raw = readFileSync(COOKIES_PATH, 'utf-8')
    return JSON.parse(raw) as Cookie[]
  } catch {
    console.error(`No cookies found at ${COOKIES_PATH}. Run pnpm twitter:save-cookies first.`)
    process.exit(1)
  }
}

async function main() {
  const cookies = loadCookies()
  const client = new TwitterClient({ cookies })

  if (!client.isAuthenticated()) {
    console.error('Not authenticated - cookies may be expired. Run pnpm twitter:save-cookies.')
    process.exit(1)
  }

  console.log('[test] Initializing session (loading x.com/messages HTML + parsing tokens)...')
  await client.initializeSession()
  console.log('[test] Session initialized.')
  console.log('[test] User ID:', client.getCurrentUserId())

  const session = client.getSession()
  console.log('[test] Verification token:', session.verificationToken ? 'present' : 'MISSING')
  console.log('[test] Animation token:', session.animationToken || 'EMPTY')
  console.log('[test] Bearer token:', session.bearerToken ? 'custom' : 'default')

  const [command, ...args] = process.argv.slice(2)

  if (command === 'send') {
    await handleSend(client, args)
  } else if (command === 'history') {
    await handleHistory(client, args)
  } else {
    await handleInbox(client)
  }
}

async function handleInbox(client: InstanceType<typeof TwitterClient>) {
  console.log('\n[test] Fetching initial inbox state...')
  const inboxState = await client.getInitialInboxState(defaultDMRequestQuery())
  const inbox = inboxState.inbox_initial_state

  if (!inbox) {
    console.error('No inbox data returned')
    return
  }

  console.log(`[test] Cursor: ${inbox.cursor?.slice(0, 30)}...`)
  console.log(`[test] Conversations: ${Object.keys(inbox.conversations ?? {}).length}`)
  console.log(`[test] Users: ${Object.keys(inbox.users ?? {}).length}`)
  console.log(`[test] Entries: ${(inbox.entries ?? []).length}`)

  const conversations = Object.values(inbox.conversations ?? {}) as any[]
  const users = (inbox.users ?? {}) as Record<string, any>

  console.log('\n--- Recent Conversations ---')
  for (const conv of conversations.slice(0, 10)) {
    const participants = (conv.participants ?? [])
      .map((p: any) => users[p.user_id]?.screen_name ?? p.user_id)
      .join(', ')
    console.log(`  ${conv.conversation_id} | ${conv.type} | @${participants}`)
  }

  console.log('\n--- Recent Messages ---')
  let msgCount = 0
  for (const entry of inbox.entries ?? []) {
    const parsed = parseTwitterEvent(entry)
    if (parsed.type === 'message' && msgCount < 10) {
      const msg = parsed.data
      const sender = users[msg.message_data.sender_id]
      console.log(`  @${sender?.screen_name ?? msg.message_data.sender_id}: ${msg.message_data.text?.slice(0, 80)}`)
      msgCount++
    }
  }
}

async function handleHistory(client: InstanceType<typeof TwitterClient>, args: string[]) {
  const targetUser = args[0]
  if (!targetUser) {
    console.error('Usage: test-messages history <username>')
    process.exit(1)
  }

  console.log(`\n[test] Looking up @${targetUser}...`)
  const searchResults = await client.searchUsers(targetUser, 5)
  const match = searchResults.find((u: any) => u.screen_name.toLowerCase() === targetUser.toLowerCase())

  if (!match) {
    console.error(`User @${targetUser} not found. Search results:`, searchResults.map((u: any) => u.screen_name))
    return
  }

  console.log(`[test] Found: @${match.screen_name} (${match.name}) - ID: ${match.id_str}`)

  const conversationId = buildConversationId(client.getCurrentUserId(), match.id_str)

  console.log(`[test] Conversation ID: ${conversationId}`)
  console.log(`[test] Fetching conversation history...`)

  try {
    const result = await client.fetchConversationContext(
      conversationId,
      defaultDMRequestQuery(),
      'FETCH_DM_CONVERSATION_HISTORY'
    )

    const timeline = result.conversation_timeline
    if (!timeline) {
      console.log('No conversation found with this user.')
      return
    }

    const users = (timeline.users ?? {}) as Record<string, any>
    console.log(`\n--- Chat with @${targetUser} ---`)

    const messages: Array<{ sender: string; text: string }> = []
    for (const entry of timeline.entries ?? []) {
      const parsed = parseTwitterEvent(entry)
      if (parsed.type === 'message') {
        const msg = parsed.data
        const sender = users[msg.message_data.sender_id]?.screen_name ?? msg.message_data.sender_id
        messages.push({ sender, text: msg.message_data.text ?? '' })
      }
    }

    for (const msg of messages.reverse()) {
      console.log(`  @${msg.sender}: ${msg.text}`)
    }
    console.log(`\n(${messages.length} messages)`)
  } catch (error) {
    console.error('Failed to fetch conversation:', error)
  }
}

async function handleSend(client: InstanceType<typeof TwitterClient>, args: string[]) {
  const targetUser = args[0]
  const messageText = args.slice(1).join(' ')

  if (!targetUser || !messageText) {
    console.error('Usage: test-messages send <username> <message>')
    process.exit(1)
  }

  console.log(`\n[test] Looking up @${targetUser}...`)
  const searchResults = await client.searchUsers(targetUser, 5)
  const match = searchResults.find((u: any) => u.screen_name.toLowerCase() === targetUser.toLowerCase())

  if (!match) {
    console.error(`User @${targetUser} not found. Search results:`, searchResults.map((u: any) => u.screen_name))
    return
  }

  console.log(`[test] Found: @${match.screen_name} (${match.name}) - ID: ${match.id_str}`)
  if (!match.is_dm_able) {
    console.warn(`[test] Warning: @${match.screen_name} may not accept DMs (is_dm_able: ${match.is_dm_able})`)
  }

  const conversationId = buildConversationId(client.getCurrentUserId(), match.id_str)

  console.log(`[test] Conversation ID: ${conversationId}`)
  console.log(`[test] Sending: "${messageText}"`)

  try {
    const result = await client.sendDirectMessage(conversationId, messageText)
    if (result.message) {
      console.log(`[test] Message sent! ID: ${result.message.message_data.id}`)
    } else {
      console.log('[test] Message sent (no message in response)')
    }
  } catch (error) {
    console.error('[test] Failed to send:', error)
  }
}

main().catch((err) => {
  console.error('[test] Fatal error:', err)
  process.exit(1)
})
