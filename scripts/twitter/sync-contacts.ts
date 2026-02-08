/**
 * Sync scraped Twitter/X contacts (mutuals) to Convex.
 * Reads .contacts.json and calls api.sync.syncTwitterContacts mutation.
 *
 * Usage: CONVEX_URL=... CONVEX_AUTH_TOKEN=... pnpm twitter:sync-contacts
 *
 * Environment variables:
 *   CONVEX_URL        - Convex deployment URL (e.g., https://your-app.convex.cloud)
 *   CONVEX_AUTH_TOKEN  - JWT auth token (get from browser dev tools or Electron stored auth)
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@cued/convex'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONTACTS_PATH = resolve(__dirname, '.contacts.json')

interface ScrapedUser {
  userId: string
  screenName: string
  name: string
  bio: string | null
}

interface ContactsResult {
  followers: ScrapedUser[]
  following: ScrapedUser[]
  mutuals: ScrapedUser[]
  scrapedAt: string
}

const BATCH_SIZE = 50

async function main() {
  const convexUrl = process.env.CONVEX_URL
  const authToken = process.env.CONVEX_AUTH_TOKEN

  if (!convexUrl) {
    console.error('[sync-contacts] Missing CONVEX_URL env var')
    process.exit(1)
  }
  if (!authToken) {
    console.error('[sync-contacts] Missing CONVEX_AUTH_TOKEN env var')
    process.exit(1)
  }

  if (!existsSync(CONTACTS_PATH)) {
    console.error(`[sync-contacts] No contacts file found at ${CONTACTS_PATH}`)
    console.error('[sync-contacts] Run "pnpm twitter:scrape-contacts" first.')
    process.exit(1)
  }

  const data: ContactsResult = JSON.parse(readFileSync(CONTACTS_PATH, 'utf-8'))
  const mutuals = data.mutuals

  console.log(`[sync-contacts] Loaded ${mutuals.length} mutuals (scraped at ${data.scrapedAt})`)

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(authToken)

  // Sync in batches
  let totalNew = 0
  let totalUpdated = 0
  let totalErrors = 0

  for (let i = 0; i < mutuals.length; i += BATCH_SIZE) {
    const batch = mutuals.slice(i, i + BATCH_SIZE)
    const contacts = batch.map((u) => ({
      name: u.name,
      handle: u.screenName,
      userId: u.userId,
      bio: u.bio,
    }))

    console.log(`[sync-contacts] Syncing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(mutuals.length / BATCH_SIZE)} (${contacts.length} contacts)`)

    try {
      const result = await client.mutation(api.sync.syncTwitterContacts, { contacts })
      totalNew += result.newContacts
      totalUpdated += result.updatedContacts
      totalErrors += result.errors.length

      if (result.errors.length > 0) {
        console.warn(`[sync-contacts] Batch errors:`, result.errors)
      }
    } catch (err) {
      console.error(`[sync-contacts] Batch failed:`, err)
      totalErrors++
    }
  }

  console.log(`[sync-contacts] Done! New: ${totalNew}, Updated: ${totalUpdated}, Errors: ${totalErrors}`)
}

main().catch((err) => {
  console.error('[sync-contacts] Fatal error:', err)
  process.exit(1)
})
