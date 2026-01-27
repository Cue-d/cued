/**
 * LinkedIn Platform Module
 *
 * Self-contained platform integration for LinkedIn messaging.
 * Exports all public interfaces needed by the rest of the app.
 */

// API client and types
export * from './api'

// Sync manager
export {
  LinkedInSyncManager,
  getLinkedInSyncManager,
  type LinkedInSyncProgress,
  type LinkedInSyncManagerOptions,
  type LinkedInFullSyncState,
} from './sync'

// Connections scraper
export { LinkedInScraper, type LinkedInConnection } from './scraper'

// Platform adapter for message queue
export { LinkedInAdapter } from './adapter'

// Auth (login/logout)
export {
  openLinkedInLogin,
  loadStoredCookies,
  checkStoredLoginStatus,
  clearLinkedInSession,
  storeEncryptedCookies,
  clearStoredCookies,
  type LinkedInLoginResult,
  type StoredCookies,
} from './auth'
