/**
 * Slack Platform Module
 *
 * Self-contained platform integration for Slack messaging.
 * Exports all public interfaces needed by the rest of the app.
 */

// API client and types
export * from './api'

// Sync manager
export {
  SlackSyncManager,
  getSlackSyncManager,
  getAllSlackSyncManagers,
  removeSlackSyncManager,
  initializeAllSlackSyncManagers,
  type SlackSyncProgress,
  type SlackSyncManagerOptions,
  type SlackFullSyncState,
  type SlackCursorState,
} from './sync'

// Platform adapter for message queue
export { SlackAdapter } from './adapter'

// Auth (login/logout and credentials)
export {
  openSlackLogin,
  clearSlackSession,
  saveSlackCredentials,
  getSlackCredentials,
  getAllSlackCredentials,
  hasSlackCredentials,
  hasSlackCredentialsForTeam,
  clearSlackCredentials,
  deleteSlackCredentials,
  validateSlackCredentials,
  isSlackStorageAvailable,
  type SlackLoginResult,
  type SlackStoredCredentials,
} from './auth'
