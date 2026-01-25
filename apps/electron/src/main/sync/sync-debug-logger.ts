/**
 * Sync Debug Logger
 * Logs filtered messages and sync events to a local file for debugging.
 *
 * Log file location: ~/Library/Application Support/PRM/sync-debug.log
 * (or equivalent userData path on other platforms)
 */

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'

// ============================================================================
// Constants
// ============================================================================

const LOG_FILE_NAME = 'sync-debug.log'
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024 // 10MB max before rotation
const MAX_ROTATED_LOGS = 3 // Keep up to 3 rotated logs

// ============================================================================
// Types
// ============================================================================

export type Platform = 'imessage' | 'gmail' | 'slack' | 'linkedin'

export interface FilteredMessageLog {
  platform: Platform
  messageId: string
  filterReason: string
  senderName?: string
  senderHandle?: string
  contentPreview?: string // First 100 chars of message
  conversationId?: string
}

export interface SyncEventLog {
  platform: Platform
  event: 'sync_start' | 'sync_complete' | 'sync_error' | 'batch_complete'
  details?: Record<string, unknown>
}

// ============================================================================
// Logger Implementation
// ============================================================================

class SyncDebugLogger {
  private logFilePath: string | null = null
  private isEnabled = true

  /**
   * Get the log file path, initializing if needed.
   */
  private getLogFilePath(): string {
    if (this.logFilePath) return this.logFilePath

    const userDataPath = app.getPath('userData')
    this.logFilePath = join(userDataPath, LOG_FILE_NAME)

    // Ensure directory exists
    const dir = dirname(this.logFilePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    return this.logFilePath
  }

  /**
   * Rotate log file if it exceeds max size.
   */
  private rotateIfNeeded(): void {
    const logPath = this.getLogFilePath()

    if (!existsSync(logPath)) return

    try {
      const stats = statSync(logPath)
      if (stats.size < MAX_LOG_SIZE_BYTES) return

      // Rotate existing logs
      for (let i = MAX_ROTATED_LOGS - 1; i >= 1; i--) {
        const oldPath = `${logPath}.${i}`
        const newPath = `${logPath}.${i + 1}`
        if (existsSync(oldPath)) {
          if (i === MAX_ROTATED_LOGS - 1) {
            // Delete oldest
            require('fs').unlinkSync(oldPath)
          } else {
            renameSync(oldPath, newPath)
          }
        }
      }

      // Rotate current log
      renameSync(logPath, `${logPath}.1`)

      // Start fresh log with rotation notice
      writeFileSync(logPath, `[${new Date().toISOString()}] Log rotated (previous log exceeded ${MAX_LOG_SIZE_BYTES} bytes)\n`)
    } catch (e) {
      console.warn('[SyncDebugLogger] Failed to rotate log:', e)
    }
  }

  /**
   * Write a line to the log file.
   */
  private writeLine(line: string): void {
    if (!this.isEnabled) return

    try {
      this.rotateIfNeeded()
      const logPath = this.getLogFilePath()
      const timestamp = new Date().toISOString()
      appendFileSync(logPath, `[${timestamp}] ${line}\n`)
    } catch (e) {
      // Fail silently - debug logging should never break sync
      console.warn('[SyncDebugLogger] Failed to write log:', e)
    }
  }

  /**
   * Enable or disable logging.
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    if (enabled) {
      this.writeLine('=== Sync debug logging enabled ===')
    }
  }

  /**
   * Log a filtered message.
   */
  logFilteredMessage(log: FilteredMessageLog): void {
    const preview = log.contentPreview
      ? `"${log.contentPreview.slice(0, 100).replace(/\n/g, ' ')}${log.contentPreview.length > 100 ? '...' : ''}"`
      : '(no content)'

    const sender = log.senderName
      ? `${log.senderName}${log.senderHandle ? ` <${log.senderHandle}>` : ''}`
      : log.senderHandle || '(unknown sender)'

    this.writeLine(
      `FILTERED [${log.platform}] reason=${log.filterReason} ` +
      `id=${log.messageId} sender=${sender} ` +
      `conv=${log.conversationId || '(none)'} content=${preview}`
    )
  }

  /**
   * Log a batch of filtered messages efficiently.
   */
  logFilteredBatch(platform: Platform, filtered: FilteredMessageLog[]): void {
    if (filtered.length === 0) return

    this.writeLine(`FILTERED_BATCH [${platform}] count=${filtered.length}`)
    for (const msg of filtered) {
      this.logFilteredMessage(msg)
    }
  }

  /**
   * Log a sync event.
   */
  logSyncEvent(log: SyncEventLog): void {
    const details = log.details
      ? ` ${JSON.stringify(log.details)}`
      : ''

    this.writeLine(`EVENT [${log.platform}] ${log.event}${details}`)
  }

  /**
   * Log sync start.
   */
  logSyncStart(platform: Platform, mode?: 'full' | 'incremental'): void {
    this.logSyncEvent({
      platform,
      event: 'sync_start',
      details: mode ? { mode } : undefined,
    })
  }

  /**
   * Log sync completion.
   */
  logSyncComplete(
    platform: Platform,
    stats: {
      messagesProcessed?: number
      messagesFiltered?: number
      conversationsProcessed?: number
      contactsCreated?: number
      errors?: number
      durationMs?: number
    }
  ): void {
    this.logSyncEvent({
      platform,
      event: 'sync_complete',
      details: stats,
    })
  }

  /**
   * Log sync error.
   */
  logSyncError(platform: Platform, error: string, context?: Record<string, unknown>): void {
    this.logSyncEvent({
      platform,
      event: 'sync_error',
      details: { error, ...context },
    })
  }

  /**
   * Log batch completion with filtering stats.
   */
  logBatchComplete(
    platform: Platform,
    stats: {
      batchNumber: number
      messagesProcessed: number
      messagesFiltered: number
      filterReasons?: Record<string, number>
    }
  ): void {
    this.logSyncEvent({
      platform,
      event: 'batch_complete',
      details: stats,
    })
  }

  /**
   * Log detailed cursor state for debugging initial sync issues.
   */
  logCursorState(
    platform: Platform,
    state: {
      cursor: number
      fullSyncStartRowid?: number
      fullSyncCursor?: number
      maxRowid: number
      mode: 'full' | 'incremental'
    }
  ): void {
    this.writeLine(
      `CURSOR_STATE [${platform}] mode=${state.mode} cursor=${state.cursor} ` +
      `fullSyncStartRowid=${state.fullSyncStartRowid ?? 'none'} ` +
      `fullSyncCursor=${state.fullSyncCursor ?? 'none'} maxRowid=${state.maxRowid}`
    )
  }

  /**
   * Log batch details before processing.
   */
  logBatchDetails(
    platform: Platform,
    details: {
      batchNumber: number
      direction: 'asc' | 'desc'
      cursorBefore: number
      cursorAfter: number
      messagesInBatch: number
      chatsInBatch: number
      rowidRange?: { min: number; max: number }
    }
  ): void {
    const range = details.rowidRange
      ? ` rowidRange=${details.rowidRange.min}-${details.rowidRange.max}`
      : ''
    this.writeLine(
      `BATCH [${platform}] #${details.batchNumber} ${details.direction.toUpperCase()} ` +
      `cursor=${details.cursorBefore}->${details.cursorAfter} ` +
      `messages=${details.messagesInBatch} chats=${details.chatsInBatch}${range}`
    )
  }

  /**
   * Log when a chat is skipped during sync.
   */
  logSkippedChat(
    platform: Platform,
    chatId: number | string,
    reason: string
  ): void {
    this.writeLine(`SKIPPED_CHAT [${platform}] chatId=${chatId} reason=${reason}`)
  }

  /**
   * Log when a message is skipped during sync.
   */
  logSkippedMessage(
    platform: Platform,
    messageId: number | string,
    reason: string,
    details?: { chatId?: number | string; content?: string }
  ): void {
    const extra = details
      ? ` chatId=${details.chatId ?? 'unknown'} content="${(details.content ?? '').slice(0, 50)}"`
      : ''
    this.writeLine(`SKIPPED_MSG [${platform}] msgId=${messageId} reason=${reason}${extra}`)
  }

  /**
   * Log full sync transition to incremental mode.
   */
  logFullSyncTransition(
    platform: Platform,
    details: {
      fullSyncStartRowid: number
      currentMaxRowid: number
      messagesSyncedInFullSync: number
      catchUpNeeded: boolean
    }
  ): void {
    this.writeLine(
      `FULL_SYNC_TRANSITION [${platform}] fullSyncStartRowid=${details.fullSyncStartRowid} ` +
      `currentMaxRowid=${details.currentMaxRowid} messagesSynced=${details.messagesSyncedInFullSync} ` +
      `catchUpNeeded=${details.catchUpNeeded} catchUpCount=${details.currentMaxRowid - details.fullSyncStartRowid}`
    )
  }

  /**
   * Log raw batch data for deep debugging.
   */
  logRawBatch(
    platform: Platform,
    batchNumber: number,
    batch: {
      cursor: number
      messages: Array<{ id: number; chatId: number; timestamp: number; text: string | null }>
      chats: Array<{ id: number; displayName: string | null; isGroup: boolean }>
    }
  ): void {
    this.writeLine(`RAW_BATCH [${platform}] #${batchNumber} cursor=${batch.cursor}`)
    this.writeLine(`  Messages (${batch.messages.length}):`)
    for (const msg of batch.messages.slice(0, 10)) { // Log first 10 messages
      const preview = msg.text ? msg.text.slice(0, 30).replace(/\n/g, ' ') : '(no text)'
      this.writeLine(`    id=${msg.id} chatId=${msg.chatId} ts=${msg.timestamp} "${preview}"`)
    }
    if (batch.messages.length > 10) {
      this.writeLine(`    ... and ${batch.messages.length - 10} more messages`)
    }
    this.writeLine(`  Chats (${batch.chats.length}):`)
    for (const chat of batch.chats) {
      this.writeLine(`    id=${chat.id} name="${chat.displayName ?? '(none)'}" isGroup=${chat.isGroup}`)
    }
  }

  /**
   * Log a custom event (for debugging specific flows).
   */
  logCustomEvent(
    platform: Platform,
    eventName: string,
    details?: Record<string, unknown>
  ): void {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : ''
    this.writeLine(`CUSTOM [${platform}] ${eventName}${detailsStr}`)
  }

  /**
   * Get the log file path for user reference.
   */
  getLogPath(): string {
    return this.getLogFilePath()
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let logger: SyncDebugLogger | null = null

export function getSyncDebugLogger(): SyncDebugLogger {
  if (!logger) {
    logger = new SyncDebugLogger()
  }
  return logger
}

/**
 * Convenience function to log a filtered message.
 */
export function logFilteredMessage(log: FilteredMessageLog): void {
  getSyncDebugLogger().logFilteredMessage(log)
}

/**
 * Convenience function to log filtered batch.
 */
export function logFilteredBatch(platform: Platform, filtered: FilteredMessageLog[]): void {
  getSyncDebugLogger().logFilteredBatch(platform, filtered)
}
