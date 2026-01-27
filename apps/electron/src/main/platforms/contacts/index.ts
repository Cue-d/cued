/**
 * Contacts Platform Module
 *
 * Self-contained platform integration for macOS Contacts.app.
 * Exports all public interfaces needed by the rest of the app.
 */

// Contacts manager (fetch, resolve, cache)
export {
  ContactsManager,
  getContactsManager,
  isSwiftContactsAvailable,
} from './manager'

// Contacts sync to Convex
export {
  syncContactsToConvex,
  type ContactsSyncResult,
} from './sync'

// Contacts watcher (file system events)
export {
  ContactsWatcher,
  getContactsWatcher,
  type ContactsWatcherEvents,
} from './watcher'
