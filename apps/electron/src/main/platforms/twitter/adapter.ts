/**
 * Twitter adapter for the unified message queue.
 */

import type { PlatformAdapter, QueuedMessage, SendResult } from '@cued/shared'
import { getTwitterSyncManager } from './sync'

const NON_RETRYABLE_PATTERNS = ['not found', 'invalid', 'forbidden', 'unauthorized', '401', '403']

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase()
  return !NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern))
}

export class TwitterAdapter implements PlatformAdapter {
  readonly platform = 'twitter' as const

  async send(message: QueuedMessage): Promise<SendResult> {
    if (!message.text) {
      return {
        success: false,
        error: 'Message text is required',
        retryable: false,
      }
    }

    if (!message.threadId) {
      return {
        success: false,
        error: 'Twitter messages require a conversation ID (threadId)',
        retryable: false,
      }
    }

    const syncManager = getTwitterSyncManager()
    const client = syncManager.client

    if (!client) {
      return {
        success: false,
        error: 'Twitter client not configured',
        retryable: true,
      }
    }

    if (!client.isAuthenticated()) {
      return {
        success: false,
        error: 'Not authenticated with Twitter',
        retryable: true,
      }
    }

    try {
      const sent = await client.sendDirectMessage(message.threadId, message.text)

      if (sent.message) {
        void syncManager.syncSentMessage(sent.message).catch((error) => {
          console.error('[TwitterAdapter] Failed to sync sent message:', error)
        })
      }

      return {
        success: true,
        messageId: sent.message?.message_data.id ?? sent.message?.id,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableError(errorMessage),
      }
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return getTwitterSyncManager().client?.isAuthenticated() ?? false
  }
}
