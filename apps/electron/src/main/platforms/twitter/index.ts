/**
 * Twitter/X Platform Module
 */

export * from './api'

export {
  TwitterSyncManager,
  getTwitterSyncManager,
  type TwitterSyncProgress,
  type TwitterSyncManagerOptions,
} from './sync'

export { TwitterScraper } from './scraper'

export { TwitterAdapter } from './adapter'

export {
  openTwitterLogin,
  loadStoredCookies,
  checkStoredLoginStatus,
  clearTwitterSession,
  storeEncryptedCookies,
  clearStoredCookies,
  type TwitterLoginResult,
  type StoredCookies,
} from './auth'
