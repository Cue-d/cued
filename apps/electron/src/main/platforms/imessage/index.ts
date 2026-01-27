/**
 * iMessage Platform Module
 *
 * Self-contained platform integration for iMessage.
 * Exports all public interfaces needed by the rest of the app.
 */

// Types
export type {
  Handle,
  Chat,
  Message,
  MessageStatus,
  Reaction,
  ChatWithMessages,
  SyncBatch,
  SyncResult,
  ResolvedContact,
} from './types'

// Chat database access
export { ChatDb } from './chat-db'

// Attributed body parser
export { extractTextFromAttributedBody } from './attributed-body'

// Sync manager
export {
  SyncManager,
  getSyncManager,
  type SyncProgress,
  type SyncManagerOptions,
} from './sync'

// Platform adapter for message queue
export { IMessageAdapter } from './adapter'
