/**
 * Signal platform module exports.
 */

export {
  SignalClient,
  type SignalClientOptions,
  type SignalContact,
  type SignalReceivedMessage,
  type SignalSendResult,
} from './client'

export {
  SignalDaemon,
  type SignalDaemonHandlers,
} from './daemon'

export {
  checkSignalLoginStatus,
  setupSignalCli,
  startLinkInTerminal,
  checkLinkResult,
  loadSignalCredentials,
  saveSignalCredentials,
  clearSignalCredentials,
  isSignalStorageAvailable,
  type SignalStoredCredentials,
} from './auth'

export {
  SignalSyncManager,
  getSignalSyncManager,
  type SignalSyncProgress,
  type SignalSyncManagerOptions,
} from './sync'

export { SignalAdapter } from './adapter'
